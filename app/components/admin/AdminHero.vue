<script setup lang="ts">
/**
 * Admin landing hero — Operations Control Center.
 *
 * Title + descriptive subtitle + 5-card KPI strip. KPIs read
 * /api/admin/summary in one round-trip; per-card severity tinting only
 * lights up when a count crosses an actionable threshold. Cards are
 * NuxtLinks that drop the user straight into the relevant secondary-
 * nav tab, so the strip doubles as a top-of-page navigator.
 */
import { computed, onMounted, ref } from 'vue'

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

const summary = ref<Summary['kpi'] | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<Summary>('/api/admin/summary')
    summary.value = res?.kpi ?? null
  } catch {
    summary.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)

type CardKey = keyof Summary['kpi']
type Card = {
  key: CardKey
  label: string
  to: { path: string; query: Record<string, string> }
  /** When the count is `>= threshold`, render the card with the
   *  matching severity. Below threshold the card is neutral.
   *  Undefined threshold means "never escalate." */
  threshold?: number
  severity?: 'info' | 'warning' | 'critical'
}

const CARDS: Card[] = [
  {
    key: 'active_users',
    label: 'Active users',
    to: { path: '/admin', query: { tab: 'users' } },
    // Active-user count is informational; never tints.
  },
  {
    key: 'pending_verifications',
    label: 'Pending verifications',
    to: { path: '/admin', query: { tab: 'verifications' } },
    threshold: 1,
    severity: 'warning',
  },
  {
    key: 'failed_imports',
    label: 'Failed imports',
    to: { path: '/admin', query: { tab: 'listing-import' } },
    threshold: 1,
    severity: 'critical',
  },
  {
    key: 'duplicate_candidates',
    label: 'Duplicate candidates',
    to: { path: '/admin', query: { tab: 'duplicates' } },
    threshold: 1,
    severity: 'warning',
  },
  {
    key: 'alerts',
    label: 'System alerts',
    to: { path: '/admin/operations', query: {} },
    threshold: 1,
    severity: 'critical',
  },
]

function valueFor(card: Card): number | null {
  if (loading.value && summary.value === null) return null
  return summary.value?.[card.key] ?? 0
}

function escalated(card: Card): boolean {
  if (card.threshold === undefined) return false
  const v = valueFor(card)
  return typeof v === 'number' && v >= card.threshold
}

function tintClass(card: Card): string {
  if (!escalated(card)) return ''
  switch (card.severity) {
    case 'critical':
      return 'border-destructive/40 ring-1 ring-destructive/30'
    case 'warning':
      return 'border-warning/40 ring-1 ring-warning/30'
    case 'info':
      return 'border-primary/40 ring-1 ring-primary/30'
    default:
      return ''
  }
}

function valueClass(card: Card): string {
  if (!escalated(card)) return 'text-foreground'
  switch (card.severity) {
    case 'critical':
      return 'text-destructive'
    case 'warning':
      return 'text-warning'
    case 'info':
      return 'text-primary'
    default:
      return 'text-foreground'
  }
}

const subtitle = computed(() => {
  if (loading.value) return 'Loading operational summary…'
  const k = summary.value
  if (!k) return 'Manage users, imports, moderation, infrastructure, and marketplace operations.'
  const flags: string[] = []
  if (k.alerts_critical > 0) flags.push(`${k.alerts_critical} critical alert${k.alerts_critical === 1 ? '' : 's'}`)
  if (k.failed_imports > 0)  flags.push(`${k.failed_imports} failed import${k.failed_imports === 1 ? '' : 's'}`)
  if (k.pending_verifications > 0) flags.push(`${k.pending_verifications} pending verification${k.pending_verifications === 1 ? '' : 's'}`)
  if (flags.length === 0) {
    return "Manage users, imports, moderation, infrastructure, and marketplace operations. Everything is running cleanly."
  }
  return `Right now: ${flags.slice(0, 2).join(' · ')}. Use the panels below to triage.`
})
</script>

<template>
  <section
    class="ui-card p-5"
    aria-label="Operations summary"
  >
    <header>
      <p class="text-eyebrow">Admin</p>
      <h1 class="mt-1 text-page-title">
        Operations Control Center
      </h1>
      <p class="mt-1.5 max-w-2xl text-sm text-muted-foreground">
        {{ subtitle }}
      </p>
    </header>

    <ul class="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <li
        v-for="c in CARDS"
        :key="c.key"
      >
        <NuxtLink
          :to="c.to"
          class="group flex h-full flex-col rounded-md border border-border bg-card px-3.5 py-3 transition-colors hover:bg-accent hover:border-border-strong focus-ring"
          :class="tintClass(c)"
        >
          <p class="text-eyebrow">
            {{ c.label }}
          </p>
          <p
            class="mt-1.5 text-metric-value"
            :class="valueClass(c)"
          >
            <span
              v-if="valueFor(c) === null"
              class="inline-block h-7 w-12 animate-pulse rounded bg-muted-foreground/15"
            />
            <span v-else>{{ valueFor(c)!.toLocaleString() }}</span>
          </p>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
