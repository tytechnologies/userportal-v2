<script setup lang="ts">
/**
 * Top-N hot barangays for a city.
 *
 * Reads /api/market/hot-areas. Each row carries a hot_score and
 * a components object showing per-signal contribution (so the user
 * sees "this barangay is hot because: deal_velocity 0.8, trust 0.4,
 * etc.").
 *
 * Deterministic, explainable. No ML, no mystery rankings.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type HotArea = {
  barangay_id: number
  city_id: number
  hot_score: number
  inquiry_velocity_30d: number
  deal_velocity_30d: number
  median_dom_days: number | null
  avg_trust_score: number | null
  listing_count: number
  components: Record<string, number>
  barangay_name: string | null
  city_name: string | null
}

const props = defineProps<{
  cityId?: number | null
  limit?: number
}>()

const areas = ref<HotArea[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ areas: HotArea[] }>('/api/market/hot-areas', {
      query: { city_id: props.cityId ?? undefined, limit: props.limit ?? 10 },
    })
    areas.value = res.areas ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load hot areas',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.cityId, props.limit], load)

// Hotness badge: text-only labels (per ui-ux-pro-max — no emoji
// as functional indicators). The text + token color carries meaning
// for screen readers; the previous emoji-prefixed labels were
// inaccessible AND inconsistent with the rest of the badge system.
// Also fixed bg-warning/10/text-warning (raw color) → semantic
// destructive token, since "Hot" is a stronger-than-warning signal.
function badgeFor(score: number): { label: string; cls: string } {
  if (score >= 1.0) return { label: 'Very hot', cls: 'bg-destructive/15 text-destructive' }
  if (score >= 0.5) return { label: 'Hot',      cls: 'bg-destructive/10 text-destructive' }
  if (score >= 0.0) return { label: 'Warm',     cls: 'bg-warning/15 text-warning' }
  return                { label: 'Cool',        cls: 'bg-primary/15 text-primary' }
}

function sortedComponents(c: Record<string, number>): Array<{ key: string; value: number }> {
  return Object.entries(c)
    .map(([key, value]) => ({ key, value: Number(value) }))
    .sort((a, b) => b.value - a.value)
}

function fmtComponentLabel(key: string): string {
  return key.replace(/_/g, ' ')
}

const isEmpty = computed(() => !loading.value && areas.value.length === 0)
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <header class="mb-3">
      <h2 class="text-sm font-semibold text-foreground">Hot areas</h2>
      <p class="text-xs text-muted-foreground">
        Top barangays ranked by composite hot_score. Each component is a
        within-city z-score; click a row to expand the breakdown.
      </p>
    </header>

    <div v-if="loading" class="text-xs text-muted-foreground">Loading…</div>

    <div
      v-else-if="isEmpty"
      class="rounded-md border border-dashed border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      No barangays have enough activity for hot-zone scoring yet (minimum 5 listings per barangay).
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="a in areas"
        :key="a.barangay_id"
        class="rounded-md border border-border bg-muted/40 p-3"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
            :class="badgeFor(a.hot_score).cls"
          >
            {{ badgeFor(a.hot_score).label }}
          </span>
          <p class="text-sm font-semibold text-foreground">
            {{ a.barangay_name || `Barangay #${a.barangay_id}` }}
          </p>
          <p class="text-[11px] text-muted-foreground">{{ a.city_name }}</p>
          <p class="ml-auto font-mono text-xs text-foreground">
            score {{ a.hot_score.toFixed(2) }}
          </p>
        </div>

        <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
          <div class="text-[11px]">
            <span class="text-muted-foreground">Inquiries 30d:</span>
            <span class="ml-1 font-semibold text-foreground">{{ a.inquiry_velocity_30d }}</span>
          </div>
          <div class="text-[11px]">
            <span class="text-muted-foreground">Deals 30d:</span>
            <span class="ml-1 font-semibold text-foreground">{{ a.deal_velocity_30d }}</span>
          </div>
          <div class="text-[11px]">
            <span class="text-muted-foreground">Median DOM:</span>
            <span class="ml-1 font-semibold text-foreground">{{ a.median_dom_days ?? '—' }}d</span>
          </div>
          <div class="text-[11px]">
            <span class="text-muted-foreground">Listings:</span>
            <span class="ml-1 font-semibold text-foreground">{{ a.listing_count }}</span>
          </div>
        </div>

        <!-- Component breakdown — explains what's driving the score. -->
        <div class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="c in sortedComponents(a.components)"
            :key="c.key"
            class="rounded-full px-1.5 py-0.5 text-[10px] font-mono"
            :class="c.value > 0 ? 'bg-success/15 text-success' : 'bg-muted/50 text-muted-foreground'"
            :title="`Contribution to hot_score from ${fmtComponentLabel(c.key)}`"
          >
            {{ fmtComponentLabel(c.key) }}: {{ c.value > 0 ? '+' : '' }}{{ c.value.toFixed(2) }}
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>
