<script setup lang="ts">
/**
 * Activity-over-time chart for the dashboard.
 *
 * Reads /api/dashboard/trend (range or days mode) per the shared
 * dashboard filter. SECURITY INVOKER on both backing RPCs so per-table
 * RLS scopes buckets to what the caller can see.
 *
 * Three series: Inquiries, New listings, Tasks completed.
 *
 * Phase 3: chrome refreshed to match the dashboard's flat aesthetic
 * (rounded-lg + bordered + no shadow). Empty + loading states use the
 * shared EmptyState + Skeleton primitives so future panels stay
 * consistent.
 */
import { onMounted, ref, watch } from 'vue'
import LineChart from '~/components/pages/overview/LineChart.vue'
import { useDashboardFilter } from '~/composables/useDashboardFilter'

type ChartShape = {
  labels: string[]
  datasets: Array<{ label: string; data: number[]; borderColor: string }>
}

const filter = useDashboardFilter()
const chartData = ref<ChartShape>({ labels: [], datasets: [] })
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const params = new URLSearchParams()
    if (filter.preset.value === 'custom') {
      params.set('from', filter.fromIso.value)
      params.set('to', filter.toIso.value)
    } else {
      const days = filter.preset.value === '7d' ? 7 : filter.preset.value === '90d' ? 90 : 30
      params.set('days', String(days))
    }
    const res = await $fetch<ChartShape>(`/api/dashboard/trend?${params.toString()}`)
    chartData.value = res ?? { labels: [], datasets: [] }
  } catch (err: any) {
    errorMessage.value = err?.statusMessage ?? err?.message ?? 'Failed to load trend.'
  } finally {
    isLoading.value = false
  }
}
onMounted(load)
watch(() => filter.watchKey.value, () => load())

// Hide the chart entirely when every dataset is all-zero — the empty
// state reads better than flat lines on the bottom axis.
const hasData = ref(false)
watch(chartData, (cd) => {
  hasData.value = (cd.datasets ?? []).some((ds) => (ds.data ?? []).some((n) => n > 0))
}, { immediate: true })
</script>

<template>
  <section
    class="ui-card"
    aria-label="Activity over time"
  >
    <header class="border-b border-border px-5 py-4">
      <h3 class="text-card-title">Activity over time</h3>
      <p class="mt-0.5 text-meta">
        Inquiries, new listings, and tasks completed per day · {{ filter.label.value }}
      </p>
    </header>

    <div class="p-5">
      <!-- Loading: bar-style skeleton that hints at the chart layout -->
      <div v-if="isLoading" class="space-y-3">
        <div class="flex items-end gap-1.5 h-56">
          <Skeleton
            v-for="n in 28"
            :key="n"
            class="flex-1"
            :style="{ height: `${30 + ((n * 13) % 70)}%` }"
          />
        </div>
        <div class="flex justify-between">
          <Skeleton class="h-3 w-12" />
          <Skeleton class="h-3 w-12" />
          <Skeleton class="h-3 w-12" />
        </div>
      </div>

      <div
        v-else-if="errorMessage"
        class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
      >
        {{ errorMessage }}
      </div>

      <EmptyState
        v-else-if="!hasData"
        variant="neutral"
        size="cozy"
        title="No activity in this window"
        :description="`No inquiries, listings, or task completions for ${filter.label.value.toLowerCase()}. Activity will appear here as it lands.`"
      />

      <div v-else class="h-[20rem] sm:h-[24rem]">
        <LineChart :chart-data="chartData" :height="320" />
      </div>
    </div>
  </section>
</template>
