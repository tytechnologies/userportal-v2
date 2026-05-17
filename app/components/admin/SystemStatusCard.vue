<script setup lang="ts">
/**
 * Admin system-health summary card.
 *
 * Sits above the tab strip on /admin. Single fetch to
 * /api/admin/system-status (just shipped) on mount + manual
 * refresh button.
 *
 * Computes a single overall status dot:
 *   green  — everything fresh and healthy
 *   yellow — degraded section OR a lagging source / cron
 *   red    — any section returned { ok: false }
 *
 * Goal is "is anything wrong I should investigate?" — not full
 * observability. Click into the relevant tab (Sources /
 * Verifications) for detail; or curl the underlying endpoint for
 * the full payload.
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type Section<T> = { ok: true; data: T } | { ok: false; error: string }

type CronRow = {
  jobname: string
  schedule: string | null
  active: boolean
  last_run_started_at: string | null
  last_run_finished_at: string | null
  last_run_status: string | null
}

type SourceRow = {
  slug: string
  display_name: string
  enabled: boolean
  staleness_ttl_hours: number
  last_ingested_at: string | null
  hours_since_last_ingest: number | null
  listing_count: number
}

type StatusPayload = {
  status: string
  timestamp: string
  elapsed_ms: number
  env: {
    email_delivery_disabled: boolean
    public_inquiries_disabled: boolean
    saved_searches_disabled: boolean
    email_provider_configured: boolean
    internal_cron_secret_set: boolean
  }
  cron: Section<CronRow[]>
  listings: Section<{
    online: number
    soft_deleted: number
    source_imported: number
    agent_created: number
    total_active: number
  }>
  sources: Section<SourceRow[]>
  verifications: Section<{
    pending: number
    approved: number
    rejected: number
    total: number
  }>
  subscriptions: Section<{
    total: number
    confirmed: number
    pending_confirm: number
  }>
  // Optional: only present after migration 20260507000008. If the
  // status endpoint is older than the dashboard build, the whole
  // section is just absent — handled gracefully by the warnings
  // computed below (skips when undefined).
  data_health?: Section<{
    orphan_listings_created_by: {
      orphan_count: number
      total_with_creator: number
    } | null
    unassigned_inquiries: {
      unassigned_total: number
      unassigned_recent: number
      total: number
    } | null
  }>
}

const data = ref<StatusPayload | null>(null)
const loading = ref(true)
const lastFetched = ref<Date | null>(null)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<StatusPayload>('/api/admin/system-status')
    data.value = res
    lastFetched.value = new Date()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load system status',
      icon: 'error',
    })
    data.value = null
  } finally {
    loading.value = false
  }
}

// Severity = worst of these:
//   - any section { ok: false }                     → red
//   - any cron job not run in > 25h                 → yellow
//   - any enabled source over its staleness TTL    → yellow
//   - flag toggles (kill switches) on               → yellow
//   - otherwise                                     → green
type Severity = 'green' | 'yellow' | 'red'
const severity = computed<Severity>(() => {
  const d = data.value
  if (!d) return 'red'

  // A returned { ok: false } anywhere = something is broken right now.
  // data_health is treated like the others when present, ignored when
  // absent (older endpoint without the field).
  const sectionFailed = [
    d.cron,
    d.listings,
    d.sources,
    d.verifications,
    d.subscriptions,
    ...(d.data_health ? [d.data_health] : []),
  ].some((s) => !s.ok)
  if (sectionFailed) return 'red'

  // Crons should run at least daily (the slowest cadence is daily).
  // A gap > 25h indicates the scheduler hasn't fired or the function failed.
  if (d.cron.ok) {
    const stale = d.cron.data.some((c) => {
      if (!c.active) return false
      if (!c.last_run_started_at) return true // active but never run
      const ageHours = (Date.now() - new Date(c.last_run_started_at).getTime()) / 3_600_000
      return ageHours > 25
    })
    if (stale) return 'yellow'
  }

  // Any enabled source past its own TTL = ingestion has stalled.
  if (d.sources.ok) {
    const lagging = d.sources.data.some((s) => {
      if (!s.enabled) return false
      if (s.hours_since_last_ingest == null) return false
      return s.hours_since_last_ingest > s.staleness_ttl_hours
    })
    if (lagging) return 'yellow'
  }

  // Kill-switch flags that should NORMALLY be off in production.
  if (
    d.env.email_delivery_disabled ||
    d.env.public_inquiries_disabled ||
    d.env.saved_searches_disabled
  ) {
    return 'yellow'
  }

  return 'green'
})

const dotClass = computed(() => {
  switch (severity.value) {
    case 'green':
      return 'bg-success'
    case 'yellow':
      return 'bg-warning'
    default:
      return 'bg-destructive'
  }
})

// Human-readable summary line. Avoids dumping every metric — the
// curl path is for that.
const summary = computed(() => {
  const d = data.value
  if (!d) return 'Loading…'

  const parts: string[] = []
  if (d.listings.ok) {
    parts.push(`${d.listings.data.online.toLocaleString()} online`)
  }
  if (d.verifications.ok && d.verifications.data.pending > 0) {
    parts.push(
      `${d.verifications.data.pending} verification${d.verifications.data.pending === 1 ? '' : 's'} pending`,
    )
  }
  if (d.sources.ok) {
    const enabled = d.sources.data.filter((s) => s.enabled).length
    if (enabled > 0) parts.push(`${enabled} source${enabled === 1 ? '' : 's'} active`)
  }
  if (d.subscriptions.ok && d.subscriptions.data.pending_confirm > 0) {
    parts.push(`${d.subscriptions.data.pending_confirm} unconfirmed subs`)
  }
  return parts.join(' · ') || 'No data'
})

// Warnings carry an optional inline action link so the operator can
// jump straight to the surface that fixes the underlying issue.
type Warning = { text: string; href?: string; linkLabel?: string }

const warnings = computed<Warning[]>(() => {
  const d = data.value
  if (!d) return []
  const w: Warning[] = []

  if (d.cron.ok) {
    for (const c of d.cron.data) {
      if (!c.active) continue
      if (!c.last_run_started_at) {
        w.push({ text: `Cron job "${c.jobname}" has never run.` })
        continue
      }
      const ageH = (Date.now() - new Date(c.last_run_started_at).getTime()) / 3_600_000
      if (ageH > 25) {
        w.push({ text: `Cron "${c.jobname}" hasn't run in ${Math.round(ageH)}h.` })
      } else if (c.last_run_status && c.last_run_status !== 'succeeded') {
        w.push({ text: `Cron "${c.jobname}" last run: ${c.last_run_status}.` })
      }
    }
  } else {
    w.push({ text: `cron status read failed: ${d.cron.error}` })
  }

  if (d.sources.ok) {
    for (const s of d.sources.data) {
      if (!s.enabled) continue
      if (s.hours_since_last_ingest == null) continue
      if (s.hours_since_last_ingest > s.staleness_ttl_hours) {
        w.push({
          text: `Source "${s.slug}" last ingested ${s.hours_since_last_ingest}h ago (TTL ${s.staleness_ttl_hours}h).`,
          href: '/admin?tab=sources',
          linkLabel: 'Open Sources →',
        })
      }
    }
  } else {
    w.push({ text: `sources status read failed: ${d.sources.error}` })
  }

  if (d.env.email_delivery_disabled) w.push({ text: 'Email delivery is DISABLED.' })
  if (d.env.public_inquiries_disabled) w.push({ text: 'Public inquiries are DISABLED.' })
  if (d.env.saved_searches_disabled) w.push({ text: 'Saved searches are DISABLED.' })

  // Email provider was removed (was Mailgun). The helper is a
  // no-op stub; suppress the warning since this is the intended
  // state until a new provider is wired in.
  // (Re-add when re-enabling email so admins notice misconfig.)

  // Data-health warnings. Only meaningful counts get listed — zero
  // orphans / unassigned shouldn't add noise. Threshold for "noisy"
  // is intentionally low (1+) since both buckets directly indicate
  // actionable cleanup work.
  if (d.data_health?.ok) {
    const orphan = d.data_health.data.orphan_listings_created_by
    if (orphan && orphan.orphan_count > 0) {
      w.push({
        text: `${orphan.orphan_count.toLocaleString()} listing${orphan.orphan_count === 1 ? '' : 's'} have created_by UUIDs with no matching profile (out of ${orphan.total_with_creator.toLocaleString()} with a creator). Inquiries on these fall back to unassigned.`,
        href: '/admin?tab=reconcile',
        linkLabel: 'Open Reconcile →',
      })
    }
    const unassigned = d.data_health.data.unassigned_inquiries
    if (unassigned && unassigned.unassigned_recent > 0) {
      w.push({
        text: `${unassigned.unassigned_recent.toLocaleString()} inquir${unassigned.unassigned_recent === 1 ? 'y' : 'ies'} in the last 7d have no assigned agent — needs manual routing.`,
        href: '/admin?tab=triage',
        linkLabel: 'Open Triage →',
      })
    }
  } else if (d.data_health && !d.data_health.ok) {
    w.push({ text: `data_health read failed: ${d.data_health.error}` })
  }

  return w
})

const showDetails = ref(false)

onMounted(load)
</script>

<template>
  <section
    class="mb-6 rounded-xl border border-border bg-background px-5 py-3"
    aria-label="System status"
  >
    <div class="flex items-center gap-3">
      <span
        :class="['inline-block w-2.5 h-2.5 rounded-full shrink-0', dotClass]"
        :title="severity"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2 flex-wrap">
          <p class="text-sm font-semibold text-foreground">System status</p>
          <p class="text-xs text-muted-foreground truncate">{{ summary }}</p>
        </div>
      </div>
      <button
        v-if="warnings.length > 0"
        type="button"
        class="text-xs font-semibold text-warning hover:underline"
        @click="showDetails = !showDetails"
      >
        {{ warnings.length }} {{ warnings.length === 1 ? 'warning' : 'warnings' }}
      </button>
      <NuxtLink
        to="/admin/operations"
        class="text-xs font-semibold text-primary hover:underline"
      >
        Open ops dashboard →
      </NuxtLink>
      <button
        type="button"
        class="text-xs text-muted-foreground hover:underline"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <!-- Warnings detail (accordion). -->
    <ul
      v-if="showDetails && warnings.length > 0"
      class="mt-3 pt-3 border-t border-border space-y-1"
    >
      <li
        v-for="(w, i) in warnings"
        :key="i"
        class="text-xs text-warning leading-snug"
      >
        • {{ w.text }}
        <NuxtLink
          v-if="w.href"
          :to="w.href"
          class="ml-1 font-semibold text-warning underline hover:no-underline"
        >
          {{ w.linkLabel }}
        </NuxtLink>
      </li>
    </ul>

    <p
      v-if="lastFetched"
      class="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70"
    >
      Last checked {{ lastFetched.toLocaleTimeString() }}
    </p>
  </section>
</template>
