<script setup lang="ts">
/**
 * Inquiry source attribution. Horizontal-bar breakdown of where leads
 * came from over the active date range. Answers the brokerage owner's
 * marketing-spend question: where are my best channels?
 *
 * Width is proportional to count (not %), so a small absolute number
 * still reads as small even if it dominates a tiny period.
 */
import { computed, onMounted, ref, watch } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'
import { useDashboardFilter } from '~/composables/useDashboardFilter'

type SourceRow = {
  source: string
  count: number
  pct: number
}
type Payload = {
  items: SourceRow[]
  total: number
  period_from: string
  period_to: string
}

const filter = useDashboardFilter()

const data = ref<Payload | null>(null)
const isLoading = ref(true)

async function load() {
  isLoading.value = true
  try {
    data.value = await $fetch<Payload>('/api/dashboard/inquiry-sources', {
      query: { from: filter.fromIso.value, to: filter.toIso.value },
    })
  } catch {
    data.value = null
  } finally {
    isLoading.value = false
  }
}

onMounted(load)
watch(() => filter.watchKey.value, load)

// Display label + color per known source. Unknown sources fall through
// to the neutral case so the chart never breaks on a new channel.
const SOURCE_META: Record<string, { label: string; color: string }> = {
  website:  { label: 'Website',  color: 'bg-primary' },
  phone:    { label: 'Phone',    color: 'bg-success' },
  whatsapp: { label: 'WhatsApp', color: 'bg-success/80' },
  walk_in:  { label: 'Walk-in',  color: 'bg-warning' },
  referral: { label: 'Referral', color: 'bg-warning/70' },
  manual:   { label: 'Other (manual)', color: 'bg-muted-foreground/40' },
  unknown:  { label: 'Unknown',  color: 'bg-muted-foreground/40' },
}

function sourceLabel(s: string): string {
  return SOURCE_META[s]?.label ?? s.replace(/_/g, ' ')
}
function sourceColor(s: string): string {
  return SOURCE_META[s]?.color ?? 'bg-muted-foreground/30'
}

const maxCount = computed(() => {
  const items = data.value?.items ?? []
  return items.length > 0 ? Math.max(...items.map((i) => i.count), 1) : 1
})

const items = computed(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)
</script>

<template>
  <UiCard variant="surface" padding="none">
    <header class="flex items-baseline justify-between border-b border-border px-5 py-4">
      <div>
        <h3 class="text-card-title">Inquiry sources</h3>
        <p class="mt-0.5 text-meta">
          {{ filter.label.value }} · {{ total.toLocaleString() }} total
        </p>
      </div>
    </header>

    <div v-if="isLoading" class="space-y-3 p-5">
      <div v-for="n in 4" :key="n" class="space-y-1">
        <div class="flex items-baseline justify-between">
          <UiSkeleton class="h-3 w-24" />
          <UiSkeleton class="h-3 w-12" />
        </div>
        <UiSkeleton class="h-2 w-full" />
      </div>
    </div>

    <div v-else-if="items.length === 0" class="p-5 text-meta">
      No inquiries in this window.
    </div>

    <ul v-else class="space-y-3 p-5">
      <li v-for="row in items" :key="row.source">
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <span class="text-sm font-medium text-foreground capitalize">
            {{ sourceLabel(row.source) }}
          </span>
          <span class="text-meta tabular-nums">
            {{ row.count.toLocaleString() }}
            <span class="ml-1 text-muted-foreground/70">{{ Math.round(row.pct * 100) }}%</span>
          </span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            :class="['h-full rounded-full transition-[width] duration-300 ease-out', sourceColor(row.source)]"
            :style="{ width: Math.max(2, Math.round((row.count / maxCount) * 100)) + '%' }"
          />
        </div>
      </li>
    </ul>
  </UiCard>
</template>
