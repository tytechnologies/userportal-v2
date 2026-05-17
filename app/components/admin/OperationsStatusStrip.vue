<script setup lang="ts">
/**
 * Operations Status Strip — persistent compact health indicator row
 * for /admin/*. Surfaces 6 ops signals at a glance without entering
 * tabs:
 *
 *   - Pending verifications     (Identity & Access)
 *   - Failed imports            (Data Operations)
 *   - Duplicate candidates      (Data Operations)
 *   - Failing webhooks          (Infrastructure)
 *   - Cron stale / failed       (Infrastructure)
 *   - System alerts (crit+warn) (Infrastructure → /admin/operations)
 *
 * Each indicator: small colored dot + label + tabular count. Tinted
 * only when count > 0; otherwise neutral so the strip stays calm on a
 * healthy day. Click-through routes the operator straight to the
 * relevant tab or page.
 *
 * Data sources — both already polled by other admin components:
 *   - /api/admin/summary (admin landing summary; pending verif,
 *     failed imports, duplicates, alerts)
 *   - /api/admin/ops/domain-health (cron + webhook detail)
 *
 * Mount cadence: 60s, matching the rest of the admin shell. Tail of
 * a transient failure is silent — the last good values stay rendered.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'

type Summary = {
  kpi: {
    active_users: number
    pending_verifications: number
    failed_imports: number
    duplicate_candidates: number
    alerts: number
    alerts_critical: number
    alerts_warning: number
  }
}

type DomainHealth = {
  webhooks?: { subscriptions_failing?: number; retry_queue_stale?: number }
  cron?:     { jobs_last_failed?: number; jobs_stale?: number }
}

const summary = ref<Summary['kpi'] | null>(null)
const domain  = ref<DomainHealth | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function load() {
  // Fire both in parallel; either failure leaves the prior value in
  // place so the strip never flickers to "—".
  await Promise.all([
    $fetch<Summary>('/api/admin/summary')
      .then((r) => { summary.value = r?.kpi ?? summary.value })
      .catch(() => { /* silent */ }),
    $fetch<DomainHealth>('/api/admin/ops/domain-health')
      .then((r) => { domain.value = r ?? domain.value })
      .catch(() => { /* silent */ }),
  ])
}

onMounted(() => {
  load()
  pollTimer = setInterval(load, 60_000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

type Severity = 'ok' | 'info' | 'warning' | 'critical'

type Indicator = {
  key: string
  label: string
  count: number
  severity: Severity
  to: string | { path: string; query: Record<string, string> }
}

const indicators = computed<Indicator[]>(() => {
  const k = summary.value
  const d = domain.value
  const out: Indicator[] = []

  // Pending verifications — anything > 0 is a warning (operator review).
  if (k) {
    const n = k.pending_verifications
    out.push({
      key: 'verifications',
      label: 'Verifications',
      count: n,
      severity: n > 0 ? 'warning' : 'ok',
      to: { path: '/admin', query: { tab: 'verifications' } },
    })
  }

  // Failed imports — anything > 0 is critical (signals broken pipeline).
  if (k) {
    const n = k.failed_imports
    out.push({
      key: 'failed_imports',
      label: 'Failed imports',
      count: n,
      severity: n > 0 ? 'critical' : 'ok',
      to: { path: '/admin', query: { tab: 'listing-import' } },
    })
  }

  // Duplicate candidates — anything > 0 is a warning (queue review).
  if (k) {
    const n = k.duplicate_candidates
    out.push({
      key: 'duplicates',
      label: 'Duplicates',
      count: n,
      severity: n > 0 ? 'warning' : 'ok',
      to: { path: '/admin', query: { tab: 'duplicates' } },
    })
  }

  // Failing webhooks — anything > 0 is critical (partner integration broken).
  if (d?.webhooks) {
    const n = (d.webhooks.subscriptions_failing ?? 0) + (d.webhooks.retry_queue_stale ?? 0)
    out.push({
      key: 'webhooks',
      label: 'Webhooks',
      count: n,
      severity: n > 0 ? 'critical' : 'ok',
      to: { path: '/admin', query: { tab: 'webhooks' } },
    })
  }

  // Cron failures / staleness — anything > 0 is a warning.
  if (d?.cron) {
    const n = (d.cron.jobs_last_failed ?? 0) + (d.cron.jobs_stale ?? 0)
    out.push({
      key: 'cron',
      label: 'Cron',
      count: n,
      severity: n > 0 ? 'warning' : 'ok',
      to: '/admin/operations',
    })
  }

  // Combined system alerts (critical + warning).
  if (k) {
    const n = k.alerts
    out.push({
      key: 'alerts',
      label: 'Alerts',
      count: n,
      severity:
        k.alerts_critical > 0 ? 'critical' :
        k.alerts_warning > 0 ? 'warning' : 'ok',
      to: '/admin/operations',
    })
  }

  return out
})

const allClear = computed(() => indicators.value.every((i) => i.count === 0))

function dotClass(s: Severity): string {
  switch (s) {
    case 'critical': return 'bg-destructive'
    case 'warning':  return 'bg-warning'
    case 'info':     return 'bg-primary'
    case 'ok':       return 'bg-success'
  }
}

function countClass(s: Severity): string {
  switch (s) {
    case 'critical': return 'text-destructive font-semibold'
    case 'warning':  return 'text-warning font-semibold'
    case 'info':     return 'text-primary font-semibold'
    case 'ok':       return 'text-muted-foreground'
  }
}
</script>

<template>
  <section
    class="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5 text-xs"
    aria-label="Operations status"
  >
    <span
      class="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
    >
      <span
        class="inline-block h-1.5 w-1.5 rounded-full"
        :class="allClear ? 'bg-success' : 'bg-warning animate-pulse'"
        aria-hidden="true"
      />
      Ops status
    </span>

    <NuxtLink
      v-for="ind in indicators"
      :key="ind.key"
      :to="ind.to"
      class="group inline-flex items-center gap-1.5 transition-opacity hover:opacity-100"
      :class="ind.count === 0 ? 'opacity-70 hover:opacity-100' : ''"
      :aria-label="`${ind.label}: ${ind.count}`"
    >
      <span
        class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        :class="dotClass(ind.severity)"
        aria-hidden="true"
      />
      <span class="text-muted-foreground group-hover:text-foreground">
        {{ ind.label }}
      </span>
      <span class="tabular-nums" :class="countClass(ind.severity)">
        {{ ind.count.toLocaleString() }}
      </span>
    </NuxtLink>
  </section>
</template>
