<script setup lang="ts">
/**
 * Inquiry-pipeline funnel widget. Four-stage horizontal bars: New →
 * In progress → Replied → Closed. Bar widths are proportional to the
 * largest bucket; click any segment to drill into /inquiries filtered
 * by status.
 *
 * Reads /api/dashboard/inquiry-funnel which respects the shared
 * dashboard date range filter.
 *
 * Phase 3: chrome refreshed (rounded-lg + bordered + no shadow) +
 * uses the shared Skeleton primitive for the loading state.
 *
 * Stage colors are kept (semantic, not decorative): new=blue,
 * in_progress=amber, replied=emerald, closed=neutral.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useDashboardFilter } from '~/composables/useDashboardFilter'

type FunnelShape = {
  new: number
  in_progress: number
  replied: number
  closed: number
}

const filter = useDashboardFilter()
const funnel = ref<FunnelShape | null>(null)
const isLoading = ref(true)

async function load() {
  isLoading.value = true
  try {
    const params = new URLSearchParams()
    params.set('from', filter.fromIso.value)
    params.set('to', filter.toIso.value)
    const res = await $fetch<FunnelShape>(`/api/dashboard/inquiry-funnel?${params.toString()}`)
    funnel.value = res ?? null
  } catch {
    funnel.value = null
  } finally {
    isLoading.value = false
  }
}

onMounted(load)
watch(() => filter.watchKey.value, () => load())

const stages = computed(() => {
  if (!funnel.value) return []
  const f = funnel.value
  const max = Math.max(f.new, f.in_progress, f.replied, f.closed, 1)
  return [
    { key: 'new',         label: 'New',         count: f.new,         color: 'bg-primary',     to: '/inquiries?status=new' },
    { key: 'in_progress', label: 'In progress', count: f.in_progress, color: 'bg-warning',    to: '/inquiries?status=in_progress' },
    { key: 'replied',     label: 'Replied',     count: f.replied,     color: 'bg-success',  to: '/inquiries?status=replied' },
    { key: 'closed',      label: 'Closed',      count: f.closed,      color: 'bg-muted-foreground/40', to: '/inquiries?status=closed' },
  ].map((s) => ({ ...s, pct: Math.round((s.count / max) * 100) }))
})

const total = computed(() => {
  if (!funnel.value) return 0
  return funnel.value.new + funnel.value.in_progress + funnel.value.replied + funnel.value.closed
})

const isEmpty = computed(() => !isLoading.value && total.value === 0)
</script>

<template>
  <section
    class="rounded-lg border border-border bg-card"
    aria-label="Inquiry pipeline"
  >
    <header class="flex items-center justify-between border-b border-border px-5 py-4">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Inquiry pipeline</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          By status · {{ filter.label.value }}
        </p>
      </div>
      <span class="rounded-full bg-muted-foreground/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-foreground/80">
        {{ total.toLocaleString() }} total
      </span>
    </header>

    <div class="px-5 py-4">
      <div v-if="isLoading" class="space-y-3.5">
        <div v-for="n in 4" :key="n" class="space-y-1.5">
          <div class="flex justify-between">
            <Skeleton class="h-3 w-20" />
            <Skeleton class="h-3 w-8" />
          </div>
          <Skeleton class="h-2 w-full" />
        </div>
      </div>

      <EmptyState
        v-else-if="isEmpty"
        variant="neutral"
        size="compact"
        title="No inquiries yet"
        description="When inquiries land, the pipeline shows the count by status."
      />

      <ul v-else class="space-y-3.5">
        <li v-for="s in stages" :key="s.key">
          <NuxtLink :to="s.to" class="block group">
            <div class="mb-1 flex items-center justify-between text-xs">
              <span class="font-medium text-foreground/80 group-hover:text-foreground">
                {{ s.label }}
              </span>
              <span class="font-semibold tabular-nums text-foreground">
                {{ s.count.toLocaleString() }}
              </span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-muted-foreground/10">
              <div
                class="h-full rounded-full transition-all"
                :class="s.color"
                :style="{ width: `${Math.max(s.pct, s.count > 0 ? 4 : 0)}%` }"
              />
            </div>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </section>
</template>
