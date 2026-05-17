<script setup lang="ts">
/**
 * Dashboard widget — caller's active deals grouped by stage.
 *
 * Reads /api/deals?mine=true&page_size=100 (RLS already scopes to
 * deals where the caller participates). Groups client-side by
 * stage_key into a horizontal bar visualization. Click a bar →
 * jump to /deals?stage_key=<key>&mine=true.
 *
 * Lightweight on purpose — uses the existing endpoint rather than
 * adding a per-broker aggregation RPC. For a single-broker view
 * the row count is small (typically <50 active deals), so the
 * client-side grouping is cheap.
 */
import { computed, onMounted, ref } from 'vue'

type Deal = {
  id: string
  stage_key: string
  closed_at: string | null
}

const STAGE_ORDER: { key: string; label: string; color: string }[] = [
  { key: 'inquiry_received',  label: 'Inquiry',       color: 'bg-muted' },
  { key: 'contacted',         label: 'Contacted',     color: 'bg-muted' },
  { key: 'viewing_scheduled', label: 'Viewing',       color: 'bg-primary/60' },
  { key: 'viewing_completed', label: 'Viewed',        color: 'bg-primary/80' },
  { key: 'negotiating',       label: 'Negotiating',   color: 'bg-warning' },
  { key: 'reservation',       label: 'Reservation',   color: 'bg-primary' },
  { key: 'documentation',     label: 'Docs',          color: 'bg-primary' },
  { key: 'financing',         label: 'Financing',     color: 'bg-primary/90' },
  { key: 'closing',           label: 'Closing',       color: 'bg-primary' },
  { key: 'closed_won',        label: 'Won',           color: 'bg-success' },
]

const deals = ref<Deal[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Deal[] }>('/api/deals', {
      query: { mine: true, page: 1, page_size: 200 },
    })
    deals.value = res.data ?? []
  } catch {
    deals.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Filter to active (not closed_lost; closed_won kept so the wins
// surface). Group by stage.
const stageCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const d of deals.value) {
    if (d.stage_key === 'closed_lost') continue
    counts[d.stage_key] = (counts[d.stage_key] || 0) + 1
  }
  return counts
})

const total = computed(() =>
  Object.values(stageCounts.value).reduce((a, b) => a + b, 0),
)

const visibleStages = computed(() =>
  STAGE_ORDER.filter((s) => (stageCounts.value[s.key] || 0) > 0),
)

const isEmpty = computed(() => !loading.value && total.value === 0)
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <header class="mb-3 flex items-baseline justify-between">
      <div>
        <p class="text-sm font-semibold text-foreground">My deals</p>
        <p class="text-xs text-muted-foreground">
          Active pipeline by stage.
        </p>
      </div>
      <NuxtLink
        to="/deals?mine=true"
        class="text-xs font-semibold text-primary hover:underline"
      >
        Open pipeline →
      </NuxtLink>
    </header>

    <div
      v-if="loading"
      class="h-16 animate-pulse rounded-md bg-muted"
    />
    <div
      v-else-if="isEmpty"
      class="rounded-md border border-dashed border-border bg-muted/50 p-4 text-center text-xs text-muted-foreground"
    >
      No active deals yet.
      <NuxtLink to="/inquiries" class="font-semibold text-primary hover:underline">
        Convert an inquiry →
      </NuxtLink>
    </div>

    <div v-else>
      <!-- Stacked bar — each stage's slice is proportional to its
           count. Click a slice → drill into /deals filtered by stage. -->
      <div class="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        <NuxtLink
          v-for="s in visibleStages"
          :key="s.key"
          :to="`/deals?mine=true&stage_key=${s.key}`"
          class="h-full transition-opacity hover:opacity-80"
          :class="s.color"
          :style="{ width: `${((stageCounts[s.key] ?? 0) / total) * 100}%` }"
          :title="`${s.label}: ${stageCounts[s.key] ?? 0}`"
        />
      </div>

      <ul class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        <li
          v-for="s in visibleStages"
          :key="s.key"
          class="flex items-center gap-1.5 text-xs"
        >
          <span class="h-2 w-2 shrink-0 rounded-full" :class="s.color" aria-hidden="true" />
          <span class="text-foreground">{{ s.label }}</span>
          <span class="ml-auto font-semibold text-foreground tabular-nums">
            {{ stageCounts[s.key] }}
          </span>
        </li>
      </ul>

      <p class="mt-2 text-[10px] text-muted-foreground/70">
        Total active: {{ total }}
      </p>
    </div>
  </section>
</template>
