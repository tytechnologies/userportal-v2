<script setup lang="ts">
/**
 * Time-series sparkline chart for the /admin/operations dashboard.
 *
 * Pure SVG — no chart library dep. Renders one or more lines on a
 * shared y-axis. Sufficient for the ops use case where the operator
 * wants "is this trending up / flat / spiking?" at a glance, not
 * pixel-perfect financial-grade plots.
 *
 * Reads /api/admin/ops/metrics?range=24h|7d|30d. Each point is a
 * snapshot row from system_metric_snapshots; the endpoint
 * downsamples 7d/30d to hourly so payload stays small.
 *
 * Multi-series toggle — operator picks which metrics to overlay
 * via checkboxes. Default: webhooks_failing + retry_queue_depth +
 * ingest_sources_stale (the three operational warning indicators).
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Range = '24h' | '7d' | '30d'

type Point = Record<string, unknown> & {
  captured_at?: string  // 24h response uses captured_at
  bucket?: string       // 7d/30d downsampled response uses bucket
}

type Series = {
  key: string
  label: string
  color: string  // tailwind-mapped hex for the SVG stroke
}

// Curated subset — operator-actionable metrics first. Adding more is
// trivial; the page renders one chart per group, so we keep the
// default count low to avoid a 12-line tangle.
const SERIES_OPTIONS: Series[] = [
  { key: 'webhook_subscriptions_failing', label: 'Webhooks failing',  color: '#dc2626' },
  { key: 'webhook_retry_queue_depth',     label: 'Retry queue depth', color: '#d97706' },
  { key: 'webhook_retry_queue_stale',     label: 'Retry queue stale', color: '#ea580c' },
  { key: 'ingest_sources_stale',          label: 'Stale ingest sources', color: '#b91c1c' },
  { key: 'ingest_runs_24h',               label: 'Ingest runs 24h',   color: '#0891b2' },
  { key: 'ingest_runs_24h_with_errors',   label: 'Ingest runs w/ errors', color: '#dc2626' },
  { key: 'inquiries_unassigned_recent_7d', label: 'Unassigned inquiries 7d', color: '#7c3aed' },
  { key: 'verifications_pending',         label: 'Verifications pending', color: '#0d9488' },
  { key: 'rate_limit_throttling_now',     label: 'Rate-limit throttling', color: '#ca8a04' },
  { key: 'listings_orphan_created_by',    label: 'Orphan created_by',  color: '#a16207' },
  { key: 'listings_online',               label: 'Online listings',    color: '#16a34a' },
]

const DEFAULT_KEYS = new Set([
  'webhook_subscriptions_failing',
  'webhook_retry_queue_depth',
  'ingest_sources_stale',
])

const range = ref<Range>('24h')
const points = ref<Point[]>([])
const loading = ref(true)
const errorMsg = ref<string | null>(null)
const selectedKeys = ref<Set<string>>(new Set(DEFAULT_KEYS))

let pollTimer: ReturnType<typeof setInterval> | null = null

async function load() {
  loading.value = true
  errorMsg.value = null
  try {
    const res = await $fetch<{ range: Range; points: Point[] }>(
      '/api/admin/ops/metrics',
      { query: { range: range.value } },
    )
    points.value = res.points || []
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load metrics'
    showToast({ title: errorMsg.value ?? '', icon: 'error' })
  } finally {
    loading.value = false
  }
}

watch(range, load)
onMounted(() => {
  load()
  // Poll every 60s — 5min snapshot cadence means more frequent
  // refreshes are mostly redundant. 60s gives the operator a moving
  // window during incident triage.
  pollTimer = setInterval(load, 60_000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function toggleSeries(key: string) {
  const next = new Set(selectedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedKeys.value = next
}

// SVG geometry. Fixed viewbox; the SVG scales to the container.
const VIEW_W = 800
const VIEW_H = 200
const PADDING_LEFT = 40
const PADDING_RIGHT = 12
const PADDING_TOP = 12
const PADDING_BOTTOM = 24

const visibleSeries = computed(() =>
  SERIES_OPTIONS.filter((s) => selectedKeys.value.has(s.key)),
)

// Time-X. Use the captured_at OR bucket field per range; both are
// timestamptz. Convert to ms for arithmetic.
function pointTime(p: Point): number {
  const v = (p.captured_at || p.bucket) as string | undefined
  if (!v) return 0
  return new Date(v).getTime()
}

const xRange = computed(() => {
  if (points.value.length === 0) return [0, 0]
  const times = points.value.map(pointTime)
  return [Math.min(...times), Math.max(...times)]
})

// Y range across ALL visible series, padded 10% so the top of the
// curve doesn't graze the chart border.
const yRange = computed(() => {
  if (visibleSeries.value.length === 0 || points.value.length === 0) return [0, 1]
  let min = Infinity
  let max = -Infinity
  for (const p of points.value) {
    for (const s of visibleSeries.value) {
      const v = Number(p[s.key])
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  // Y origin at 0 — operational counters are 0-anchored; clipping the
  // baseline just to make the curve "fill" would mislead.
  min = Math.min(0, min)
  // Ensure non-zero range to avoid division-by-zero in xToCoord.
  if (max === min) max = min + 1
  return [min, max * 1.1]
})

function xToCoord(t: number): number {
  const [t0, t1] = xRange.value as [number, number]
  if (t1 === t0) return PADDING_LEFT
  const w = VIEW_W - PADDING_LEFT - PADDING_RIGHT
  return PADDING_LEFT + ((t - t0) / (t1 - t0)) * w
}
function yToCoord(v: number): number {
  const [y0, y1] = yRange.value as [number, number]
  if (y1 === y0) return VIEW_H - PADDING_BOTTOM
  const h = VIEW_H - PADDING_TOP - PADDING_BOTTOM
  return PADDING_TOP + h - ((v - y0) / (y1 - y0)) * h
}

// Path string for one series — `M x0 y0 L x1 y1 ...`.
function pathFor(series: Series): string {
  if (points.value.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < points.value.length; i++) {
    const p = points.value[i]!
    const v = Number(p[series.key])
    if (!Number.isFinite(v)) continue
    const x = xToCoord(pointTime(p))
    const y = yToCoord(v)
    parts.push(`${parts.length === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  return parts.join(' ')
}

// Y-axis label set — 4 evenly-spaced ticks. Integer-rounded since our
// metrics are counts.
const yTicks = computed(() => {
  const [y0, y1] = yRange.value as [number, number]
  const ticks: { y: number; label: string }[] = []
  for (let i = 0; i <= 4; i++) {
    const v = y0 + (y1 - y0) * (i / 4)
    ticks.push({ y: yToCoord(v), label: Math.round(v).toLocaleString() })
  }
  return ticks
})

// X-axis labels — first, middle, last point's timestamp.
const xTicks = computed(() => {
  if (points.value.length < 2) return []
  const fmt = (iso: string) => {
    const d = new Date(iso)
    if (range.value === '24h') {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  const first = points.value[0]!
  const mid = points.value[Math.floor(points.value.length / 2)]!
  const last = points.value[points.value.length - 1]!
  return [
    { x: xToCoord(pointTime(first)), label: fmt((first.captured_at || first.bucket) as string) },
    { x: xToCoord(pointTime(mid)),   label: fmt((mid.captured_at || mid.bucket) as string) },
    { x: xToCoord(pointTime(last)),  label: fmt((last.captured_at || last.bucket) as string) },
  ]
})
</script>

<template>
  <section
    class="rounded-xl border border-border bg-background p-4"
    aria-label="Operational time-series"
  >
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-sm font-semibold text-foreground">Trends</p>
      <div class="ml-auto flex gap-1 rounded-lg border border-border bg-background p-1">
        <button
          v-for="r in (['24h', '7d', '30d'] as const)"
          :key="r"
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-semibold"
          :class="range === r ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted'"
          @click="range = r"
        >
          {{ r }}
        </button>
      </div>
    </div>

    <!-- Series legend / toggle -->
    <div class="mb-3 flex flex-wrap gap-1.5">
      <button
        v-for="s in SERIES_OPTIONS"
        :key="s.key"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
        :class="selectedKeys.has(s.key)
          ? 'border-border bg-muted text-foreground'
          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
        @click="toggleSeries(s.key)"
      >
        <span
          class="inline-block h-2 w-2 rounded-full"
          :style="{ backgroundColor: s.color }"
          aria-hidden="true"
        />
        {{ s.label }}
      </button>
    </div>

    <!-- Loading / error / chart -->
    <div
      v-if="loading && points.length === 0"
      class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      Loading…
    </div>
    <div
      v-else-if="errorMsg"
      class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
    >
      {{ errorMsg }}
    </div>
    <div
      v-else-if="points.length === 0"
      class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      No snapshots yet. The 5-minute capture cron runs as
      <code class="rounded bg-card px-1">system_metric_snapshot_5min</code>;
      data appears within ~5 minutes of the migration applying.
    </div>
    <div
      v-else-if="visibleSeries.length === 0"
      class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      Select at least one series above to see its trend.
    </div>

    <svg
      v-else
      :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
      class="w-full h-auto"
      role="img"
      :aria-label="`${range} trend chart for ${visibleSeries.length} metrics`"
    >
      <!-- Y grid -->
      <line
        v-for="t in yTicks"
        :key="`yg-${t.y}`"
        :x1="PADDING_LEFT"
        :x2="VIEW_W - PADDING_RIGHT"
        :y1="t.y"
        :y2="t.y"
        stroke="#e5e7eb"
        stroke-width="1"
      />
      <!-- Y labels -->
      <text
        v-for="t in yTicks"
        :key="`yl-${t.y}`"
        :x="PADDING_LEFT - 6"
        :y="t.y + 4"
        text-anchor="end"
        font-size="10"
        fill="#6b7280"
      >{{ t.label }}</text>

      <!-- X labels -->
      <text
        v-for="(t, i) in xTicks"
        :key="`xl-${i}`"
        :x="t.x"
        :y="VIEW_H - 6"
        text-anchor="middle"
        font-size="10"
        fill="#6b7280"
      >{{ t.label }}</text>

      <!-- Series paths -->
      <path
        v-for="s in visibleSeries"
        :key="s.key"
        :d="pathFor(s)"
        :stroke="s.color"
        stroke-width="1.5"
        fill="none"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>

    <p class="mt-2 text-[10px] text-muted-foreground/70">
      Snapshots captured every 5min via
      <code class="rounded bg-muted px-1">system_metric_snapshot_5min</code>;
      auto-refresh every 60s.
    </p>
  </section>
</template>
