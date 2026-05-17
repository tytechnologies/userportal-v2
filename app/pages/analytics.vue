<script setup lang="ts">
// Analytics hub. Two domain panels driven by parallel fetches:
//
//   1. Listings — totals, status splits, by-category bar, monthly
//      created line. Sourced from analytics.services on the client.
//
//   2. Pipeline + Documents — deal counts by stage, win rate, gross
//      closed-won value, and document-status throughput. Sourced from
//      /api/analytics/pipeline (RLS-scoped).
//
// The two panels paint independently so a 500 on one doesn't blank
// the page. Charts are lazy-loaded — chart.js is ~50 KB gzipped and
// not needed until the canvas mounts.
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { fetchAnalyticsSummary, type AnalyticsSummary } from '~/services/analytics.services'
import { formatMoney } from '~/utils'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'
import UiSectionHeader from '~/components/ui/UiSectionHeader.vue'

useHead({
  title: 'Analytics | Housinginteractive',
})

definePageMeta({
  layout: 'default',
})

const AnalyticsBarChart = defineAsyncComponent(
  () => import('~/components/analytics/AnalyticsBarChart.vue'),
)
const AnalyticsLineChart = defineAsyncComponent(
  () => import('~/components/analytics/AnalyticsLineChart.vue'),
)

const supabase = useSupabaseClient()
const user = useSupabaseUser()

const summary = ref<AnalyticsSummary | null>(null)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)

// Pipeline + document slice. Independent of the listings summary —
// rendered as a separate panel that paints/errors on its own.
type PipelineSummary = {
  deals: {
    total: number
    open: number
    won: number
    lost: number
    winRate: number
    grossWonValue: number
    avgDaysToClose: number
    byStage: Record<string, number>
  }
  drafts: {
    total: number
    byStatus: Record<string, number>
    unknown: number
  }
}
const pipeline = ref<PipelineSummary | null>(null)
const isPipelineLoading = ref(true)
const pipelineError = ref<string | null>(null)

async function load() {
  isLoading.value = true
  errorMessage.value = null
  isPipelineLoading.value = true
  pipelineError.value = null

  // Two independent loads — fire in parallel; errors shape per panel
  // so a deals 500 doesn't blank the listings panel and vice versa.
  await Promise.allSettled([
    (async () => {
      try {
        summary.value = await fetchAnalyticsSummary(supabase, user.value?.id)
      } catch (err: any) {
        console.error('[analytics] listings load failed:', err)
        errorMessage.value = err?.message || 'Failed to load listings analytics'
      } finally {
        isLoading.value = false
      }
    })(),
    (async () => {
      try {
        pipeline.value = await $fetch<PipelineSummary>('/api/analytics/pipeline')
      } catch (err: any) {
        console.error('[analytics] pipeline load failed:', err)
        pipelineError.value = err?.statusMessage ?? err?.message ?? 'Failed to load pipeline analytics'
      } finally {
        isPipelineLoading.value = false
      }
    })(),
  ])
}

onMounted(load)

const categoryLabels = computed(() => Object.keys(summary.value?.byCategory ?? {}))
const categoryValues = computed(() =>
  Object.values(summary.value?.byCategory ?? {}).map((v) => Number(v) || 0),
)
const monthLabels = computed(() => (summary.value?.byMonth ?? []).map((m) => m.month))
const monthValues = computed(() => (summary.value?.byMonth ?? []).map((m) => m.count))

// Pipeline derived data: bar chart of deal count by stage. Stages
// stay in canonical order (matching the kanban) so the chart axis
// reads left-to-right as the funnel progresses; closed_won and
// closed_lost are split off into their own stat cards rather than
// the bar so the funnel chart stays clean.
const STAGE_DISPLAY: Array<{ key: string; label: string }> = [
  { key: 'inquiry_received',   label: 'Inquiry' },
  { key: 'contacted',          label: 'Contacted' },
  { key: 'viewing_scheduled',  label: 'Viewing scheduled' },
  { key: 'viewing_completed',  label: 'Viewing done' },
  { key: 'negotiating',        label: 'Negotiating' },
  { key: 'reservation',        label: 'Reservation' },
  { key: 'documentation',      label: 'Documentation' },
  { key: 'financing',          label: 'Financing' },
  { key: 'closing',            label: 'Closing' },
]
const pipelineStageLabels = computed(() => STAGE_DISPLAY.map((s) => s.label))
const pipelineStageValues = computed(() =>
  STAGE_DISPLAY.map((s) => pipeline.value?.deals.byStage?.[s.key] ?? 0),
)

const winRatePct = computed(() => {
  const r = pipeline.value?.deals.winRate ?? 0
  return `${(r * 100).toFixed(0)}%`
})
const avgDaysToCloseLabel = computed(() => {
  const d = pipeline.value?.deals.avgDaysToClose ?? 0
  if (d <= 0) return '—'
  if (d < 1) return '<1 day'
  return `${d.toFixed(1)} days`
})

const draftStatusOrder: Array<{ key: string; label: string; tone: 'neutral' | 'warning' | 'success' | 'muted' }> = [
  { key: 'draft',     label: 'Drafting',     tone: 'neutral' },
  { key: 'in_review', label: 'In review',    tone: 'warning' },
  { key: 'signed',    label: 'Signed',       tone: 'success' },
  { key: 'archived',  label: 'Archived',     tone: 'muted'   },
]
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <UiPageHeader
      title="Analytics"
      description="Listings, pipeline, and document throughput at a glance."
    />

    <!-- Loading skeleton — matches the KPI grid + chart shape so the
         layout doesn't reflow when real data arrives. -->
    <div v-if="isLoading" class="space-y-6">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div v-for="n in 5" :key="n" class="ui-card p-4">
          <UiSkeleton class="mb-2 h-3 w-20" />
          <UiSkeleton class="h-6 w-24" />
        </div>
      </div>
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="ui-card p-5">
          <UiSkeleton class="mb-3 h-4 w-32" />
          <UiSkeleton class="h-64 w-full" />
        </div>
        <div class="ui-card p-5">
          <UiSkeleton class="mb-3 h-4 w-32" />
          <UiSkeleton class="h-64 w-full" />
        </div>
      </div>
    </div>

    <UiCard
      v-else-if="errorMessage"
      class="!border-destructive/30 !bg-destructive/10 text-center"
    >
      <p class="text-sm text-destructive">{{ errorMessage }}</p>
      <button
        type="button"
        class="mt-3 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 focus-ring"
        @click="load"
      >
        Try again
      </button>
    </UiCard>

    <div v-else-if="summary" class="space-y-6">
      <UiSectionHeader title="Listings" />
      <!-- KPI cards -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <UiStatCard label="Total" :value="summary.totalListings.toLocaleString()" />
        <UiStatCard
          label="Active"
          :value="summary.active.toLocaleString()"
          tone="success"
        />
        <UiStatCard
          label="Archived"
          :value="summary.archived.toLocaleString()"
        />
        <UiStatCard
          label="For Sale"
          :value="summary.forSale.toLocaleString()"
          :delta="`avg ${formatMoney(summary.avgSalePrice, true) || '—'}`"
        />
        <UiStatCard
          label="For Rent"
          :value="summary.forRent.toLocaleString()"
          :delta="`avg ${formatMoney(summary.avgRentPrice, true) || '—'}/mo`"
        />
      </div>

      <!-- Charts -->
      <div class="grid gap-4 lg:grid-cols-2">
        <UiCard>
          <UiSectionHeader title="Listings by category" />
          <div class="mt-4">
            <AnalyticsBarChart
              :labels="categoryLabels"
              :values="categoryValues"
              label="Listings"
            />
          </div>
        </UiCard>
        <UiCard>
          <UiSectionHeader title="Listings created" eyebrow="Last 12 months" />
          <div class="mt-4">
            <AnalyticsLineChart
              :labels="monthLabels"
              :values="monthValues"
              label="Listings"
            />
          </div>
        </UiCard>
      </div>
    </div>

    <!-- Pipeline + Documents panel. Independent of the listings panel
         above — paints its own loading/error state so a 500 on one
         slice doesn't blank the whole page. -->
    <div class="space-y-4">
      <UiSectionHeader
        title="Pipeline & Documents"
        eyebrow="RLS-scoped to deals + drafts you can see"
      />

      <div v-if="isPipelineLoading" class="space-y-4">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <div v-for="n in 5" :key="n" class="ui-card p-4">
            <UiSkeleton class="mb-2 h-3 w-20" />
            <UiSkeleton class="h-6 w-24" />
          </div>
        </div>
        <div class="ui-card p-5">
          <UiSkeleton class="mb-3 h-4 w-32" />
          <UiSkeleton class="h-48 w-full" />
        </div>
      </div>

      <UiCard
        v-else-if="pipelineError"
        class="!border-destructive/30 !bg-destructive/10 text-center"
      >
        <p class="text-sm text-destructive">{{ pipelineError }}</p>
        <button
          type="button"
          class="mt-3 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 focus-ring"
          @click="load"
        >
          Try again
        </button>
      </UiCard>

      <div v-else-if="pipeline" class="space-y-4">
        <!-- Pipeline KPI strip. Win rate is the headline metric;
             gross closed-won is the value-of-business metric; avg
             days-to-close is the cycle-time metric. -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <UiStatCard label="Open deals" :value="pipeline.deals.open.toLocaleString()" tone="primary" />
          <UiStatCard label="Won" :value="pipeline.deals.won.toLocaleString()" tone="success" />
          <UiStatCard label="Lost" :value="pipeline.deals.lost.toLocaleString()" tone="destructive" />
          <UiStatCard label="Win rate" :value="winRatePct" />
          <UiStatCard
            label="Closed-won value"
            :value="formatMoney(pipeline.deals.grossWonValue, true) || '—'"
            :delta="`avg ${avgDaysToCloseLabel} to close`"
          />
        </div>

        <!-- Funnel chart: counts by stage in canonical order. Empty
             stages stay on the axis so the funnel shape stays visible
             when activity is concentrated in early or late stages. -->
        <UiCard>
          <UiSectionHeader title="Deals by stage" eyebrow="Open + closed, all-time" />
          <div class="mt-4">
            <AnalyticsBarChart
              :labels="pipelineStageLabels"
              :values="pipelineStageValues"
              label="Deals"
            />
          </div>
        </UiCard>

        <!-- Documents throughput. Plain stat strip rather than a chart
             — four buckets is too few to justify a canvas, and a strip
             reads faster at a glance. -->
        <UiCard>
          <UiSectionHeader
            title="Documents by status"
            :eyebrow="`${pipeline.drafts.total.toLocaleString()} total drafts + imports`"
          />
          <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <UiStatCard
              v-for="s in draftStatusOrder"
              :key="s.key"
              :label="s.label"
              :value="(pipeline.drafts.byStatus[s.key] ?? 0).toLocaleString()"
              :tone="s.tone === 'muted' ? 'neutral' : (s.tone as any)"
            />
          </div>
          <p
            v-if="pipeline.drafts.unknown > 0"
            class="mt-3 text-[11px] text-muted-foreground"
          >
            {{ pipeline.drafts.unknown }} draft{{ pipeline.drafts.unknown === 1 ? '' : 's' }}
            with non-canonical status — likely from a legacy import. Re-tag from the drafts hub.
          </p>
        </UiCard>
      </div>
    </div>
  </AdminPageShell>
</template>
