<script setup lang="ts">
/**
 * Alert feed for /admin/operations.
 *
 * Reads /api/admin/ops/alerts — derived from the public.ops_alerts
 * SQL view (no separate storage). Always fresh.
 *
 * Each alert has:
 *   key       — stable id for the underlying condition
 *   severity  — critical | warning | info
 *   category  — webhook | ingest | cron | rate_limit
 *   title     — operator-readable headline
 *   detail    — supplementary line
 *   metadata  — payload for drilldown
 *   started_at — when the underlying condition began
 *
 * Filter chips on top let the operator narrow by severity / category.
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Alert = {
  key: string
  severity: 'critical' | 'warning' | 'info'
  category: 'webhook' | 'ingest' | 'cron' | 'rate_limit'
  title: string
  detail: string | null
  metadata: Record<string, unknown> | null
  started_at: string
}

type Counts = { critical: number; warning: number; info: number }

const alerts = ref<Alert[]>([])
const counts = ref<Counts>({ critical: 0, warning: 0, info: 0 })
const loading = ref(true)
const severityFilter = ref<'' | 'critical' | 'warning' | 'info'>('')
const categoryFilter = ref<'' | 'webhook' | 'ingest' | 'cron' | 'rate_limit'>('')

let pollTimer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    const res = await $fetch<{ data: Alert[]; counts: Counts }>(
      '/api/admin/ops/alerts',
      {
        query: {
          severity: severityFilter.value || undefined,
          category: categoryFilter.value || undefined,
          limit: 200,
        },
      },
    )
    alerts.value = res.data ?? []
    counts.value = res.counts ?? { critical: 0, warning: 0, info: 0 }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load alerts',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

watch([severityFilter, categoryFilter], load)

onMounted(() => {
  load()
  // Poll every 30s — alerts are derived from a SQL view that's
  // already cheap; this is the operator's primary anomaly surface.
  pollTimer = setInterval(load, 30_000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 0) return d.toLocaleString()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

const severityClass = (s: Alert['severity']) =>
  s === 'critical'
    ? 'bg-destructive/15 text-destructive ring-destructive/30'
    : s === 'warning'
      ? 'bg-warning/15 text-warning ring-warning/30'
      : 'bg-primary/15 text-primary ring-primary/30'

const dotClass = (s: Alert['severity']) =>
  s === 'critical'
    ? 'bg-destructive'
    : s === 'warning'
      ? 'bg-warning'
      : 'bg-primary'

function drilldownHref(a: Alert): string | null {
  // Each alert category routes to the existing tab that lets the
  // operator act on the underlying record. Metadata payload is
  // ignored at the link level (the destination tab loads its own
  // detail from the row id surfaced in metadata).
  switch (a.category) {
    case 'webhook':
      return '/admin?tab=webhooks'
    case 'ingest':
      return '/admin?tab=sources'
    case 'cron':
      // No dedicated cron tab; the system-status card surfaces them
      // and the dashboard's own cron panel will be the home.
      return null
    case 'rate_limit':
      return null
    default:
      return null
  }
}

const isEmpty = computed(() => !loading.value && alerts.value.length === 0)
</script>

<template>
  <section
    class="ui-card p-4"
    aria-label="Operational alerts"
  >
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-section-title">Alerts</p>
      <span
        v-if="counts.critical > 0"
        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-destructive/15 text-destructive ring-1 ring-destructive/30"
      >
        {{ counts.critical }} critical
      </span>
      <span
        v-if="counts.warning > 0"
        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-warning/15 text-warning ring-1 ring-warning/30"
      >
        {{ counts.warning }} warning
      </span>
      <span
        v-if="counts.info > 0"
        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-primary/15 text-primary ring-1 ring-primary/30"
      >
        {{ counts.info }} info
      </span>
      <select
        v-model="severityFilter"
        class="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs"
      >
        <option value="">All severities</option>
        <option value="critical">Critical only</option>
        <option value="warning">Warning only</option>
        <option value="info">Info only</option>
      </select>
      <select
        v-model="categoryFilter"
        class="rounded-md border border-border bg-background px-2 py-1 text-xs"
      >
        <option value="">All categories</option>
        <option value="webhook">Webhooks</option>
        <option value="ingest">Ingest</option>
        <option value="cron">Cron</option>
        <option value="rate_limit">Rate limits</option>
      </select>
    </div>

    <div
      v-if="loading && alerts.length === 0"
      class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      Loading alerts…
    </div>
    <div
      v-else-if="isEmpty"
      class="flex flex-col items-center justify-center gap-2 rounded-md border border-success/30 bg-success/10 p-6 text-center text-sm text-success"
    >
      <!-- SVG check-circle in lieu of an emoji per ui-ux-pro-max
           pre-delivery checklist (no emoji as icons). -->
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M16 6L8 14l-4-4" />
        <circle cx="10" cy="10" r="9" />
      </svg>
      <span>No active alerts. Everything looks healthy.</span>
    </div>
    <ul v-else class="space-y-2">
      <li
        v-for="a in alerts"
        :key="a.key"
        class="rounded-md border border-border bg-muted/40 p-3"
      >
        <div class="flex items-start gap-2">
          <span
            class="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
            :class="dotClass(a.severity)"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-2">
              <p class="text-sm font-semibold text-foreground">{{ a.title }}</p>
              <span
                :class="['rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1', severityClass(a.severity)]"
              >
                {{ a.severity }}
              </span>
              <span class="text-[10px] uppercase tracking-wide text-muted-foreground">
                {{ a.category }}
              </span>
              <span class="ml-auto text-xs text-muted-foreground">
                {{ formatTs(a.started_at) }}
              </span>
            </div>
            <p
              v-if="a.detail"
              class="mt-0.5 text-xs text-foreground"
            >
              {{ a.detail }}
            </p>
            <NuxtLink
              v-if="drilldownHref(a)"
              :to="drilldownHref(a)!"
              class="mt-1 inline-block text-xs font-semibold text-primary hover:underline"
            >
              Open {{ a.category }} →
            </NuxtLink>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
