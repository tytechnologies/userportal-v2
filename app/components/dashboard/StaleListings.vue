<script setup lang="ts">
// "Listings going stale" widget. Surfaces online listings that haven't
// been updated in ≥ 30 days — they drift down in search rank and are
// silent revenue leaks. Click a row to open the listing detail page;
// the widget header links to the full /listings table for triage.
//
// Empty state ("no stale listings") is the desirable steady state so
// it's a positive checkmark, not a sad-empty illustration.

import { onMounted, ref } from 'vue'

type StaleRow = {
  listing_id: number
  title: string | null
  property_category: string | null
  city_name: string | null
  updated_at: string | null
}

const total = ref(0)
const rows = ref<StaleRow[]>([])
const isLoading = ref(true)
const thresholdDays = ref(30)

async function load() {
  try {
    const res = await $fetch<{
      total: number
      threshold_days: number
      data: StaleRow[]
    }>('/api/dashboard/stale-listings?days=30&limit=5')
    total.value = res?.total ?? 0
    rows.value = res?.data ?? []
    thresholdDays.value = res?.threshold_days ?? 30
  } catch {
    total.value = 0
    rows.value = []
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

function daysSince(iso: string | null): number {
  if (!iso) return 0
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000))
}
</script>

<template>
  <section class="rounded-xl border border-border bg-background shadow-sm">
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Listings going stale</h3>
        <p class="text-xs text-muted-foreground">
          Online · not updated in {{ thresholdDays }}+ days
        </p>
      </div>
      <span
        v-if="!isLoading"
        class="rounded-full px-2 py-0.5 text-xs font-semibold"
        :class="total > 0 ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'"
      >
        {{ total }}
      </span>
    </header>

    <div v-if="isLoading" class="space-y-2 p-4">
      <div v-for="n in 3" :key="n" class="h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>

    <div
      v-else-if="rows.length === 0"
      class="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground/70"
    >
      <span class="text-lg" aria-hidden="true">✓</span>
      <p>Nothing stale. Every online listing is fresh.</p>
    </div>

    <ul v-else class="divide-y divide-border">
      <li v-for="r in rows" :key="r.listing_id">
        <NuxtLink
          :to="`/listings/${r.listing_id}`"
          class="flex items-start gap-3 px-4 py-3 hover:bg-accent hover:text-accent-foreground"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-foreground">
              {{ r.title || `Listing #${r.listing_id}` }}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              <span v-if="r.property_category" class="capitalize">{{ r.property_category }}</span>
              <span v-if="r.city_name"> · {{ r.city_name }}</span>
            </p>
          </div>
          <span class="shrink-0 text-xs text-warning">
            {{ daysSince(r.updated_at) }}d
          </span>
        </NuxtLink>
      </li>
    </ul>

    <footer
      v-if="total > rows.length"
      class="border-t border-border px-4 py-2 text-center text-xs"
    >
      <NuxtLink to="/listings" class="text-primary hover:underline">
        View all {{ total }} stale listings →
      </NuxtLink>
    </footer>
  </section>
</template>
