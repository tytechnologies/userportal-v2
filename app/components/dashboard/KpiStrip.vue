<script setup lang="ts">
// Top-of-dashboard KPI strip. Four click-through cards with a single
// number + label. Data comes from /api/dashboard/stats which batches
// all four counts into one round trip; missing rows return 0 not 500
// so the strip always paints.
//
// Visual treatment is intentionally restrained — gradient bars, big
// numbers, no sparklines yet. Phase B brings real time-series data
// to enable trend indicators.

import { onMounted, ref } from 'vue'

type Stats = {
  kpi: {
    active_listings: number
    new_inquiries_7d: number
    open_tasks_mine: number
    pending_shares_incoming: number
  }
}

const stats = ref<Stats['kpi'] | null>(null)
const isLoading = ref(true)

async function load() {
  try {
    const res = await $fetch<Stats>('/api/dashboard/stats')
    stats.value = res?.kpi ?? null
  } catch {
    stats.value = null
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

// Card config drives the render so the layout grows with the schema —
// add a new key + entry and the strip rebalances. Tailwind grid
// auto-fits up to 4 columns at lg.
//
// Estate aesthetic: KPIs are quieter "is everything OK" widgets, not
// the lede. A 0 is a positive signal ("all clear"), not a void —
// emptyCopy gives each card a calm, contextual reassurance instead.
const cards = [
  {
    key: 'active_listings' as const,
    label: 'Active listings',
    sublabel: 'Online · not deleted',
    emptyCopy: 'No active listings',
    to: '/listings',
  },
  {
    key: 'new_inquiries_7d' as const,
    label: 'New inquiries',
    sublabel: 'Last 7 days',
    emptyCopy: 'Inbox is quiet',
    to: '/inquiries?status=new',
  },
  {
    key: 'open_tasks_mine' as const,
    label: 'My open tasks',
    sublabel: 'Assigned to me',
    emptyCopy: 'You\'re caught up',
    to: '/tasks?assigned=me',
  },
  {
    key: 'pending_shares_incoming' as const,
    label: 'Share invites',
    sublabel: 'Awaiting your response',
    emptyCopy: 'No pending invites',
    to: '/shares',
  },
] as const

function valueOf(key: keyof Stats['kpi']): number | null {
  if (isLoading.value) return null
  return stats.value?.[key] ?? 0
}
</script>

<template>
  <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <NuxtLink
      v-for="c in cards"
      :key="c.key"
      :to="c.to"
      class="group rounded-xl bg-card px-5 py-5 transition-colors duration-150 ease-out hover:bg-accent/40 focus-ring"
    >
      <div class="flex items-center gap-2">
        <!-- Brass dot when nonzero — quiet "this number matters"
             signal. Hidden when the count is 0 (positive empty state)
             or while loading. -->
        <span
          v-if="valueOf(c.key) !== null && valueOf(c.key)! > 0"
          class="h-1.5 w-1.5 rounded-full bg-brass"
          aria-hidden="true"
        />
        <p class="text-eyebrow">{{ c.label }}</p>
      </div>
      <template v-if="valueOf(c.key) === null">
        <p class="mt-3 text-metric-value">
          <span class="inline-block h-7 w-14 animate-pulse rounded bg-muted" />
        </p>
        <p class="mt-1 text-meta">{{ c.sublabel }}</p>
      </template>
      <template v-else-if="valueOf(c.key) === 0">
        <p class="mt-3 font-display text-2xl font-medium tracking-tight text-muted-foreground">
          {{ c.emptyCopy }}
        </p>
        <p class="mt-1 text-meta">{{ c.sublabel }}</p>
      </template>
      <template v-else>
        <p class="mt-3 text-metric-value">
          {{ valueOf(c.key)!.toLocaleString() }}
        </p>
        <p class="mt-1 text-meta">{{ c.sublabel }}</p>
      </template>
    </NuxtLink>
  </section>
</template>
