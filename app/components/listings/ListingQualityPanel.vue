<script setup lang="ts">
/**
 * Listing quality score breakdown.
 *
 * Reads /api/listings/:id/quality. The endpoint returns total +
 * per-component values; this component renders a stacked
 * proportional bar plus a legend so the broker sees exactly which
 * components are dragging the score down.
 *
 * Deterministic by design: the score is built from explicit
 * components (images, description, verification, freshness, etc.).
 * No black-box ML — every number is auditable.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Component = {
  key: string
  label: string
  value: number
  max: number
}

const props = defineProps<{
  listingId: string | number
}>()

const totalScore = ref<number | null>(null)
const components = ref<Component[]>([])
const computedAt = ref<string | null>(null)
const pending = ref(false)
const message = ref<string | null>(null)
const loading = ref(true)

async function load() {
  if (props.listingId == null) return
  loading.value = true
  try {
    const res = await $fetch<{
      total_score: number | null
      components: Component[] | null
      computed_at: string | null
      pending: boolean
      message?: string
    }>(`/api/listings/${props.listingId}/quality`)
    totalScore.value = res.total_score
    components.value = res.components ?? []
    computedAt.value = res.computed_at
    pending.value    = res.pending
    message.value    = res.message ?? null
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load quality score',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.listingId, load)

function colorFor(c: Component): string {
  // Components ordered visually: hot-warm-cool palette helps the
  // broker scan which areas are weak. Bar color = how full it is.
  const ratio = c.max > 0 ? c.value / c.max : 0
  if (ratio >= 0.8) return 'bg-success'
  if (ratio >= 0.5) return 'bg-warning'
  return 'bg-destructive'
}

const grade = computed(() => {
  const s = totalScore.value ?? 0
  if (s >= 85) return { label: 'Excellent', class: 'bg-success/15 text-success' }
  if (s >= 70) return { label: 'Good',      class: 'bg-primary/15 text-primary' }
  if (s >= 50) return { label: 'Fair',      class: 'bg-warning/15 text-warning' }
  return                { label: 'Needs work', class: 'bg-destructive/15 text-destructive' }
})
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Listing quality</h3>
        <p class="text-xs text-muted-foreground">
          Deterministic score (0–100). Refreshed hourly.
        </p>
      </div>
      <div v-if="totalScore != null" class="flex items-center gap-2">
        <span class="text-2xl font-semibold text-foreground">{{ totalScore.toFixed(0) }}</span>
        <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold" :class="grade.class">
          {{ grade.label }}
        </span>
      </div>
    </header>

    <div v-if="loading" class="text-xs text-muted-foreground">Loading…</div>

    <div
      v-else-if="pending"
      class="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
    >
      {{ message || 'Score pending; computed hourly.' }}
    </div>

    <div v-else-if="totalScore != null">
      <!-- Component breakdown -->
      <ul class="space-y-2">
        <li v-for="c in components" :key="c.key" class="text-xs">
          <div class="flex items-baseline justify-between">
            <span class="text-foreground">{{ c.label }}</span>
            <span class="font-mono text-[11px] text-muted-foreground">
              {{ c.value.toFixed(1) }} / {{ c.max }}
            </span>
          </div>
          <div class="mt-1 h-1.5 w-full rounded-full bg-muted">
            <div
              :class="colorFor(c)"
              class="h-1.5 rounded-full transition-all"
              :style="{ width: `${(c.value / c.max) * 100}%` }"
            />
          </div>
        </li>
      </ul>

      <p v-if="computedAt" class="mt-3 text-[10px] text-muted-foreground/70">
        Computed {{ new Date(computedAt).toLocaleString() }}
      </p>
    </div>
  </section>
</template>
