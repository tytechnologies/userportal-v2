<script setup lang="ts">
/**
 * Analytics-grade KPI strip for the redesigned dashboard. Shows six
 * always-visible metrics that answer the brokerage owner's daily
 * "how is the business doing?" question:
 *
 *   1. Active listings           — inventory health
 *   2. New inquiries (7d)        — top-of-funnel velocity
 *   3. Open deals (count + ₱)    — pipeline depth
 *   4. Won (30d, ₱)              — bottom-of-funnel revenue volume
 *   5. Pipeline value            — total open ₱ committed
 *   6. Win rate (30d)            — quality signal
 *
 * Single round-trip via /api/dashboard/stats — re-uses the existing
 * endpoint extended with a `pipeline` block.
 *
 * No sparklines yet (would need a time-series endpoint per metric).
 * Trend deltas are intentionally omitted until we have point-in-time
 * comparison; faking them would erode trust faster than not having them.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useDashboardFilter } from '~/composables/useDashboardFilter'

type Stats = {
  kpi: {
    active_listings: number
    new_inquiries_7d: number
    open_tasks_mine: number
    pending_shares_incoming: number
  }
  pipeline?: {
    open_deals_count: number
    open_deals_value: number
    won_period_count: number
    won_period_value: number
    lost_period_count: number
    win_rate_period: number | null
    conversion_rate_period: number | null
    period_from: string
    period_to: string
    currency: string
  }
}

const filter = useDashboardFilter()

const stats = ref<Stats | null>(null)
const isLoading = ref(true)
const fetchErrored = ref(false)

async function load() {
  isLoading.value = true
  fetchErrored.value = false
  try {
    stats.value = await $fetch<Stats>('/api/dashboard/stats', {
      query: { from: filter.fromIso.value, to: filter.toIso.value },
    })
  } catch {
    stats.value = null
    fetchErrored.value = true
  } finally {
    isLoading.value = false
  }
}

onMounted(load)
// Refetch when the picker fires. Stable watchKey collapses the two
// underlying refs so we don't double-fire.
watch(() => filter.watchKey.value, load)

function formatMoney(n: number, currency = 'PHP'): string {
  if (!Number.isFinite(n) || n === 0) return `₱0`
  if (n >= 1_000_000_000) return `₱${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `₱${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `₱${(n / 1_000).toFixed(0)}K`
  return `₱${n.toLocaleString()}`
}

function formatPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${Math.round(n * 100)}%`
}

type Card = {
  key: string
  label: string
  primary: string
  secondary: string
  to: string
  /** Tone tints the value text only (subtle). */
  tone?: 'neutral' | 'success' | 'warning'
}

const cards = computed<Card[]>(() => {
  const k = stats.value?.kpi
  const p = stats.value?.pipeline
  return [
    {
      key: 'active_listings',
      label: 'Active listings',
      primary: k ? k.active_listings.toLocaleString() : '—',
      secondary: 'Online · not deleted',
      to: '/listings',
    },
    {
      key: 'new_inquiries_7d',
      label: 'New inquiries',
      primary: k ? k.new_inquiries_7d.toLocaleString() : '—',
      secondary: 'Last 7 days',
      to: '/inquiries?status=new',
    },
    {
      key: 'open_deals',
      label: 'Open deals',
      primary: p ? p.open_deals_count.toLocaleString() : '—',
      secondary: p ? `${formatMoney(p.open_deals_value, p.currency)} pipeline` : 'Pipeline value',
      to: '/deals',
    },
    {
      key: 'won_period',
      label: `Won (${filter.label.value.toLowerCase()})`,
      primary: p ? formatMoney(p.won_period_value, p.currency) : '—',
      secondary: p ? `${p.won_period_count} deal${p.won_period_count === 1 ? '' : 's'} closed` : 'Closed-won volume',
      to: '/deals?status=won',
      tone: 'success',
    },
    {
      key: 'win_rate',
      label: 'Win rate',
      primary: formatPct(p?.win_rate_period ?? null),
      secondary: p && p.win_rate_period != null
        ? `${p.won_period_count} of ${p.won_period_count + p.lost_period_count} closed`
        : `No closed deals (${filter.label.value.toLowerCase()})`,
      to: '/deals',
      tone: p?.win_rate_period != null && p.win_rate_period >= 0.4 ? 'success' : (p?.win_rate_period != null && p.win_rate_period < 0.2 ? 'warning' : 'neutral'),
    },
    {
      key: 'conversion',
      label: 'Conversion',
      primary: formatPct(p?.conversion_rate_period ?? null),
      secondary: `Inquiries → deals (${filter.label.value.toLowerCase()})`,
      to: '/inquiries',
    },
  ]
})

function valueClass(tone?: 'neutral' | 'success' | 'warning'): string {
  if (tone === 'success') return 'text-success'
  if (tone === 'warning') return 'text-warning'
  return 'text-foreground'
}

// True when stats loaded successfully but the broker has nothing in
// the system across every baseline metric — the day-1 case. Six cards
// each showing ₱0 / 0 looks like a broken dashboard; one "no activity
// yet" card reads as intentional.
const isFirstRunEmpty = computed(() => {
  if (isLoading.value || fetchErrored.value || !stats.value) return false
  const k = stats.value.kpi
  const p = stats.value.pipeline
  return (
    (k?.active_listings ?? 0) === 0
    && (k?.new_inquiries_7d ?? 0) === 0
    && (p?.open_deals_count ?? 0) === 0
    && (p?.won_period_count ?? 0) === 0
    && (p?.lost_period_count ?? 0) === 0
  )
})
</script>

<template>
  <!-- Error: stats endpoint failed (network / 401 / 500). Persistent
       card so the operator knows the numbers below aren't reliable. -->
  <section
    v-if="fetchErrored"
    class="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4"
  >
    <p class="text-eyebrow text-destructive">Performance metrics unavailable</p>
    <p class="mt-1 text-sm text-muted-foreground">
      Could not load dashboard stats. Refresh the page, or check back in a minute.
    </p>
    <button
      type="button"
      class="mt-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-ring"
      @click="load"
    >
      Retry
    </button>
  </section>

  <!-- First-run empty: every baseline metric is 0. Replaces the six
       ghost cards (each reading "₱0" / "—") with a single intentional
       getting-started card. Self-resolves once the broker has any
       inventory or pipeline activity. -->
  <section
    v-else-if="isFirstRunEmpty"
    class="rounded-xl border border-dashed border-border bg-muted/30 px-5 py-6 text-center"
  >
    <p class="text-eyebrow">Performance · last 30 days</p>
    <p class="mt-1 text-base font-semibold text-foreground">No activity yet</p>
    <p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
      Numbers light up here once you have listings published, inquiries arriving, or deals moving through the pipeline.
    </p>
    <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
      <NuxtLink
        to="/listings/new"
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring"
      >
        Add your first listing
      </NuxtLink>
      <NuxtLink
        to="/inquiries"
        class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-ring"
      >
        Open inquiries
      </NuxtLink>
    </div>
  </section>

  <!-- Standard 6-card strip. Mobile-first: single column on phones,
       2 columns at sm (≥640px), 3 at lg (≥1024px), 6 at xl (≥1280px). -->
  <section v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
    <NuxtLink
      v-for="c in cards"
      :key="c.key"
      :to="c.to"
      class="group rounded-xl border border-border bg-card px-4 py-4 transition-colors duration-150 ease-out hover:border-primary/40 hover:bg-accent/30 focus-ring"
    >
      <p class="text-eyebrow truncate">{{ c.label }}</p>
      <p
        :class="['mt-2 text-2xl font-semibold tracking-tight tabular-nums', valueClass(c.tone)]"
      >
        <span v-if="isLoading" class="inline-block h-7 w-16 animate-pulse rounded bg-muted" />
        <span v-else>{{ c.primary }}</span>
      </p>
      <p class="mt-1 truncate text-meta">{{ c.secondary }}</p>
    </NuxtLink>
  </section>
</template>
