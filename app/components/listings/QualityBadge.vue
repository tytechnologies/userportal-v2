<script setup lang="ts">
/**
 * Quality badge — tiny pill showing the listing's quality grade.
 *
 * Reads /api/listings/:id/quality. Pure decorative — clicking opens
 * the full ListingQualityPanel (already shipped) for the breakdown.
 *
 * Three states:
 *   - score loaded: colored pill with label
 *   - pending (MV not refreshed yet): gray "scoring…"
 *   - error / no data: hidden (badge is non-essential)
 */
import { ref, computed, onMounted, watch } from 'vue'

const props = defineProps<{
  listingId: string | number
}>()

const totalScore = ref<number | null>(null)
const pending = ref(false)
const errored = ref(false)

async function load() {
  if (props.listingId == null) return
  errored.value = false
  pending.value = false
  try {
    const res = await $fetch<{ total_score: number | null; pending: boolean }>(
      `/api/listings/${props.listingId}/quality`,
    )
    totalScore.value = res.total_score
    pending.value = res.pending
  } catch {
    errored.value = true
  }
}

onMounted(load)
watch(() => props.listingId, load)

const badge = computed(() => {
  const s = totalScore.value
  if (s == null) return null
  if (s >= 85) return { label: 'Excellent',    class: 'bg-success/15 text-success' }
  if (s >= 70) return { label: 'Good quality', class: 'bg-primary/15 text-primary' }
  if (s >= 50) return { label: 'Fair',         class: 'bg-warning/15 text-warning' }
  return                { label: 'Needs work', class: 'bg-destructive/15 text-destructive' }
})
</script>

<template>
  <span
    v-if="badge"
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
    :class="badge.class"
    :title="`Quality score: ${totalScore?.toFixed(0)}`"
  >
    {{ badge.label }}
  </span>
  <span
    v-else-if="pending"
    class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
    title="Quality score computed hourly; pending first refresh"
  >
    Scoring…
  </span>
  <!-- errored / no data: render nothing -->
</template>
