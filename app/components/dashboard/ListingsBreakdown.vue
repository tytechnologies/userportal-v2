<script setup lang="ts">
/**
 * Inventory composition snapshot — answers "what kind of listings am
 * I sitting on right now?" Stacked horizontal bar across sale/rent/
 * both, plus a residential vs commercial split below, plus a calm
 * line about how many drafts are sitting offline.
 *
 * No date filter — this is a state snapshot, not a window.
 */
import { computed, onMounted, ref } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'

type Payload = {
  online: {
    sale_only: number
    rent_only: number
    both: number
    residential: number
    commercial: number
    total: number
  }
  offline: number
  total: number
}

const data = ref<Payload | null>(null)
const isLoading = ref(true)

async function load() {
  isLoading.value = true
  try {
    data.value = await $fetch<Payload>('/api/dashboard/listings-breakdown')
  } catch {
    data.value = null
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

const onlineTotal = computed(() => data.value?.online.total ?? 0)

// Stacked-bar segments for the online listings.
const segments = computed(() => {
  const o = data.value?.online
  if (!o || onlineTotal.value === 0) return []
  return [
    { key: 'sale_only', label: 'For sale', count: o.sale_only, color: 'bg-primary',       to: '/listings?for=sale' },
    { key: 'rent_only', label: 'For rent', count: o.rent_only, color: 'bg-success',       to: '/listings?for=rent' },
    { key: 'both',      label: 'Both',     count: o.both,      color: 'bg-warning',       to: '/listings' },
  ].filter((s) => s.count > 0)
})

const residentialPct = computed(() => {
  const o = data.value?.online
  if (!o || onlineTotal.value === 0) return 0
  return Math.round((o.residential / onlineTotal.value) * 100)
})
const commercialPct = computed(() => {
  const o = data.value?.online
  if (!o || onlineTotal.value === 0) return 0
  return Math.round((o.commercial / onlineTotal.value) * 100)
})
</script>

<template>
  <UiCard variant="surface" padding="none">
    <header class="flex items-baseline justify-between border-b border-border px-5 py-4">
      <div>
        <h3 class="text-card-title">Inventory breakdown</h3>
        <p class="mt-0.5 text-meta">Online listings · current state</p>
      </div>
      <NuxtLink to="/listings" class="text-meta hover:text-foreground">
        View listings
      </NuxtLink>
    </header>

    <div v-if="isLoading" class="space-y-3 p-5">
      <UiSkeleton class="h-3 w-1/3" />
      <UiSkeleton class="h-2.5 w-full" />
      <div class="flex gap-4 pt-2">
        <UiSkeleton class="h-3 w-20" />
        <UiSkeleton class="h-3 w-20" />
        <UiSkeleton class="h-3 w-20" />
      </div>
    </div>

    <div v-else-if="onlineTotal === 0" class="p-5 text-meta">
      No live listings. Add one from <NuxtLink to="/listings/new" class="text-primary hover:underline">/listings/new</NuxtLink>
      to populate the inventory view.
    </div>

    <div v-else class="space-y-4 p-5">
      <!-- Headline number -->
      <div class="flex items-baseline justify-between">
        <p class="text-3xl font-semibold tabular-nums text-foreground">
          {{ onlineTotal.toLocaleString() }}
        </p>
        <span class="text-meta">live online</span>
      </div>

      <!-- Stacked bar -->
      <div class="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        <NuxtLink
          v-for="s in segments"
          :key="s.key"
          :to="s.to"
          :class="[s.color, 'h-full transition-[width] duration-300 ease-out hover:opacity-80']"
          :style="{ width: Math.max(2, Math.round((s.count / onlineTotal) * 100)) + '%' }"
          :title="`${s.label}: ${s.count.toLocaleString()}`"
        />
      </div>

      <!-- Legend -->
      <ul class="grid grid-cols-3 gap-2 text-xs">
        <li v-for="s in segments" :key="s.key" class="flex items-center gap-1.5">
          <span :class="['inline-block h-2 w-2 rounded-full', s.color]" aria-hidden="true" />
          <span class="text-foreground">{{ s.label }}</span>
          <span class="ml-auto tabular-nums text-muted-foreground">{{ s.count.toLocaleString() }}</span>
        </li>
      </ul>

      <!-- Residential vs commercial split + offline drafts -->
      <div class="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-3 text-xs">
        <span class="text-muted-foreground">
          Residential <strong class="text-foreground">{{ residentialPct }}%</strong>
          ·
          Commercial <strong class="text-foreground">{{ commercialPct }}%</strong>
        </span>
        <span v-if="data && data.offline > 0" class="text-muted-foreground">
          + {{ data.offline.toLocaleString() }} draft{{ data.offline === 1 ? '' : 's' }} offline
        </span>
      </div>
    </div>
  </UiCard>
</template>
