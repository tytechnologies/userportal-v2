<script setup lang="ts">
/**
 * Storage panel for /admin/operations.
 *
 * Renders one row per public-schema table with total size, breakdown
 * (table / index / TOAST), row estimate, and 24h + 7d byte deltas.
 * Sortable by clicking column headers.
 *
 * Reads /api/admin/ops/db-growth (admin-gated).
 *
 * Why a sortable table instead of a chart: storage trends are
 * inherently per-table (one curve per table is illegible on a 60-row
 * deployment); a table lets the operator scan for "what's biggest"
 * and "what's growing fastest" in two clicks.
 */
import { computed, onMounted, ref } from 'vue'
import { showToast } from '~/helpers/helpers'

type Row = {
  schema_name: string
  table_name: string
  total_bytes: number
  table_bytes: number
  index_bytes: number
  toast_bytes: number
  row_estimate: number
  delta_24h: number | null
  delta_7d: number | null
  captured_at: string
}

type SortKey = 'table_name' | 'total_bytes' | 'row_estimate' | 'delta_24h' | 'delta_7d'

const rows = ref<Row[]>([])
const loading = ref(true)
const errorMsg = ref<string | null>(null)

const sortKey = ref<SortKey>('total_bytes')
const sortDir = ref<'asc' | 'desc'>('desc')

async function load() {
  loading.value = true
  errorMsg.value = null
  try {
    const res = await $fetch<{ tables: Row[] }>('/api/admin/ops/db-growth')
    rows.value = res.tables || []
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load storage metrics'
    showToast({ title: errorMsg.value ?? '', icon: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(load)

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    // Numeric columns default to descending — operator wants
    // "biggest / fastest growing first."
    sortDir.value = key === 'table_name' ? 'asc' : 'desc'
  }
}

const sortedRows = computed(() => {
  const out = [...rows.value]
  const key = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  out.sort((a, b) => {
    const av: any = a[key]
    const bv: any = b[key]
    // Nulls sort last regardless of direction — makes the
    // "no baseline yet" rows visually segregated from real data.
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'string') return av.localeCompare(bv) * dir
    return (av - bv) * dir
  })
  return out
})

const totalBytes = computed(() =>
  rows.value.reduce((acc, r) => acc + (r.total_bytes || 0), 0),
)
const maxRowBytes = computed(() =>
  rows.value.reduce((m, r) => Math.max(m, r.total_bytes || 0), 0),
)

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${bytes} B`
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (abs < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDelta(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes === 0) return '0'
  const sign = bytes > 0 ? '+' : '−'
  return sign + formatBytes(Math.abs(bytes))
}

function deltaColor(bytes: number | null): string {
  if (bytes == null) return 'text-muted-foreground/70'
  if (bytes === 0) return 'text-muted-foreground'
  // Growth is the expected state; only flag dramatic per-day jumps.
  // > 50MB/day is "worth a look," > 250MB/day is "investigate."
  if (bytes > 250 * 1024 * 1024) return 'text-destructive'
  if (bytes > 50 * 1024 * 1024) return 'text-warning'
  if (bytes < -1024 * 1024) return 'text-success'
  return 'text-foreground'
}

function sortIndicator(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' ↑' : ' ↓'
}

function rowBarWidth(row: Row): string {
  if (!maxRowBytes.value || !row.total_bytes) return '0%'
  return `${(row.total_bytes / maxRowBytes.value) * 100}%`
}
</script>

<template>
  <section
    class="rounded-xl border border-border bg-background p-4"
    aria-label="Database storage"
  >
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-sm font-semibold text-foreground">Storage</p>
      <p v-if="rows.length > 0" class="text-xs text-muted-foreground">
        {{ rows.length }} tables · {{ formatBytes(totalBytes) }} total
      </p>
      <button
        type="button"
        class="ml-auto rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>

    <div
      v-if="loading && rows.length === 0"
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
      v-else-if="rows.length === 0"
      class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      No snapshots yet. The daily capture runs as
      <code class="rounded bg-card px-1">system_table_size_snapshot_daily</code>;
      data appears within ~5 minutes of the migration applying.
    </div>

    <div v-else class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead>
          <tr class="border-b border-border text-left text-muted-foreground">
            <th
              class="cursor-pointer py-1.5 pr-3 font-semibold hover:text-foreground"
              @click="setSort('table_name')"
            >
              Table{{ sortIndicator('table_name') }}
            </th>
            <th
              class="cursor-pointer py-1.5 pr-3 text-right font-semibold hover:text-foreground"
              @click="setSort('total_bytes')"
            >
              Total{{ sortIndicator('total_bytes') }}
            </th>
            <th class="py-1.5 pr-3 text-right font-semibold">Heap</th>
            <th class="py-1.5 pr-3 text-right font-semibold">Indexes</th>
            <th class="py-1.5 pr-3 text-right font-semibold">TOAST</th>
            <th
              class="cursor-pointer py-1.5 pr-3 text-right font-semibold hover:text-foreground"
              @click="setSort('row_estimate')"
              title="From pg_class.reltuples — estimate, not exact."
            >
              Rows ≈{{ sortIndicator('row_estimate') }}
            </th>
            <th
              class="cursor-pointer py-1.5 pr-3 text-right font-semibold hover:text-foreground"
              @click="setSort('delta_24h')"
            >
              Δ 24h{{ sortIndicator('delta_24h') }}
            </th>
            <th
              class="cursor-pointer py-1.5 text-right font-semibold hover:text-foreground"
              @click="setSort('delta_7d')"
            >
              Δ 7d{{ sortIndicator('delta_7d') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in sortedRows"
            :key="`${r.schema_name}.${r.table_name}`"
            class="border-b border-border last:border-0 hover:bg-accent hover:text-accent-foreground"
          >
            <td class="py-1.5 pr-3">
              <div class="flex flex-col">
                <code class="font-mono text-[11px] text-foreground">{{ r.table_name }}</code>
                <div class="mt-0.5 h-1 w-32 overflow-hidden rounded bg-muted">
                  <div
                    class="h-full bg-primary"
                    :style="{ width: rowBarWidth(r) }"
                  />
                </div>
              </div>
            </td>
            <td class="py-1.5 pr-3 text-right font-semibold tabular-nums text-foreground">
              {{ formatBytes(r.total_bytes) }}
            </td>
            <td class="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
              {{ formatBytes(r.table_bytes) }}
            </td>
            <td class="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
              {{ formatBytes(r.index_bytes) }}
            </td>
            <td class="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
              {{ r.toast_bytes ? formatBytes(r.toast_bytes) : '—' }}
            </td>
            <td class="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
              {{ r.row_estimate.toLocaleString() }}
            </td>
            <td
              class="py-1.5 pr-3 text-right tabular-nums"
              :class="deltaColor(r.delta_24h)"
            >
              {{ formatDelta(r.delta_24h) }}
            </td>
            <td
              class="py-1.5 text-right tabular-nums"
              :class="deltaColor(r.delta_7d)"
            >
              {{ formatDelta(r.delta_7d) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="mt-2 text-[10px] text-muted-foreground/70">
      Daily snapshots via
      <code class="rounded bg-muted px-1">system_table_size_snapshot_daily</code>
      at 03:30 UTC. Δ columns show "—" until a prior snapshot exists in
      the matching window. Row counts are estimates from
      <code class="rounded bg-muted px-1">pg_class.reltuples</code>.
    </p>
  </section>
</template>
