<script setup lang="ts">
/**
 * Overview-card grid for /admin/operations.
 *
 * Reads /api/admin/ops/overview — single round-trip aggregate.
 * Each card shows a headline number + optional drilldown link to the
 * relevant existing admin tab (Sources, Webhooks, Triage, Reconcile).
 *
 * Visual severity: cards bias their accent color based on whether
 * the metric represents trouble (failing webhooks, stale sources,
 * orphan listings) versus a baseline count (online listings).
 */
import { computed } from 'vue'

type Overview = {
  captured_at: string
  listings: {
    online: number
    soft_deleted: number
    source_imported: number
    agent_created: number
    total_active: number
  } | null
  webhooks: {
    subscriptions_total: number
    subscriptions_enabled: number
    subscriptions_failing: number
    subscriptions_disabled: number
    retry_queue_depth: number
    retry_queue_stale: number
  } | null
  ingest: {
    sources_enabled: number
    sources_stale: number
    runs_24h: number
    runs_24h_with_errors: number
  } | null
  inquiries: {
    unassigned_total: number
    unassigned_recent_7d: number
  } | null
  alerts: {
    critical: number
    warning: number
    info: number
  } | null
}

const props = defineProps<{
  overview: Overview | null
  loading: boolean
}>()

type Card = {
  label: string
  value: string
  trouble?: boolean
  href?: string
  hint?: string
}

const cards = computed<Card[]>(() => {
  const o = props.overview
  if (!o) return []
  const c: Card[] = []

  // Listings
  if (o.listings) {
    c.push({
      label: 'Active listings',
      value: o.listings.online.toLocaleString(),
      hint: `${o.listings.total_active.toLocaleString()} active total`,
    })
    c.push({
      label: 'Source-imported',
      value: o.listings.source_imported.toLocaleString(),
      hint: 'From listing_sources',
      href: '/admin?tab=sources',
    })
  }

  // Webhooks
  if (o.webhooks) {
    c.push({
      label: 'Active subscriptions',
      value: `${o.webhooks.subscriptions_enabled} / ${o.webhooks.subscriptions_total}`,
      href: '/admin?tab=webhooks',
    })
    if (o.webhooks.subscriptions_failing > 0) {
      c.push({
        label: 'Failing webhooks',
        value: String(o.webhooks.subscriptions_failing),
        trouble: true,
        href: '/admin?tab=webhooks',
        hint: '≥ 5 consecutive failures',
      })
    }
    c.push({
      label: 'Retry queue',
      value: String(o.webhooks.retry_queue_depth),
      trouble: o.webhooks.retry_queue_stale > 0,
      hint:
        o.webhooks.retry_queue_stale > 0
          ? `${o.webhooks.retry_queue_stale} overdue`
          : 'All on-schedule',
      href: '/admin?tab=webhooks',
    })
  }

  // Ingest
  if (o.ingest) {
    c.push({
      label: 'Ingest sources',
      value: `${o.ingest.sources_enabled - o.ingest.sources_stale} / ${o.ingest.sources_enabled}`,
      trouble: o.ingest.sources_stale > 0,
      hint:
        o.ingest.sources_stale > 0
          ? `${o.ingest.sources_stale} past their TTL`
          : 'All fresh',
      href: '/admin?tab=sources',
    })
    c.push({
      label: 'Ingest runs (24h)',
      value: String(o.ingest.runs_24h),
      trouble: o.ingest.runs_24h_with_errors > 0,
      hint:
        o.ingest.runs_24h_with_errors > 0
          ? `${o.ingest.runs_24h_with_errors} with errors`
          : 'Clean',
    })
  }

  // Inquiries triage
  if (o.inquiries) {
    if (o.inquiries.unassigned_recent_7d > 0) {
      c.push({
        label: 'Unassigned (7d)',
        value: String(o.inquiries.unassigned_recent_7d),
        trouble: true,
        href: '/admin?tab=triage',
        hint: 'Needs manual routing',
      })
    }
  }

  return c
})
</script>

<template>
  <div>
    <div
      v-if="loading && !overview"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
    >
      <div
        v-for="i in 8"
        :key="i"
        class="h-20 rounded-xl border border-border bg-muted/50 animate-pulse"
      />
    </div>
    <div
      v-else
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
    >
      <component
        v-for="(card, i) in cards"
        :is="card.href ? 'NuxtLink' : 'div'"
        :key="i"
        :to="card.href"
        :class="[
          'rounded-xl border p-3 transition-colors',
          card.trouble
            ? 'border-destructive/30 bg-destructive/10'
            : 'border-border bg-card',
          card.href ? 'hover:border-primary/30 hover:bg-primary/10' : '',
        ]"
      >
        <p
          class="text-xs uppercase tracking-wide"
          :class="card.trouble ? 'text-destructive' : 'text-muted-foreground'"
        >
          {{ card.label }}
        </p>
        <p
          class="mt-1 text-2xl font-semibold"
          :class="card.trouble ? 'text-destructive' : 'text-foreground'"
        >
          {{ card.value }}
        </p>
        <p
          v-if="card.hint"
          class="mt-0.5 text-xs"
          :class="card.trouble ? 'text-destructive' : 'text-muted-foreground'"
        >
          {{ card.hint }}
        </p>
      </component>
    </div>
  </div>
</template>
