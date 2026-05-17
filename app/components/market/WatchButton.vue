<script setup lang="ts">
/**
 * Drop-in "Watch" button for any building / city / barangay /
 * broker / developer / organization page.
 *
 * Reads /api/me/watches once on mount to determine the current
 * subscription state for the (target_type, target_id) pair, then
 * toggles via POST/DELETE. Alert-type selection deferred to a
 * follow-up modal — v1 uses the table's defaults (all kinds for
 * the target type).
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type TargetType = 'building' | 'city' | 'barangay' | 'broker' | 'developer' | 'organization'

const props = defineProps<{
  targetType: TargetType
  targetId: string | number
  label?: string
}>()

const watchId = ref<string | null>(null)
const checking = ref(true)
const submitting = ref(false)

async function loadState() {
  checking.value = true
  try {
    const res = await $fetch<{ watches: Array<{ id: string; target_type: string; target_id: string }> }>(
      '/api/me/watches',
    )
    const match = (res.watches || []).find(
      (w) => w.target_type === props.targetType && String(w.target_id) === String(props.targetId),
    )
    watchId.value = match?.id ?? null
  } catch {
    // Silent — button just shows "Watch" and a click attempts to add.
    watchId.value = null
  } finally {
    checking.value = false
  }
}

onMounted(loadState)
watch(() => [props.targetType, props.targetId], loadState)

async function toggle() {
  if (submitting.value) return
  submitting.value = true
  try {
    if (watchId.value) {
      await $fetch(`/api/me/watches/${watchId.value}`, { method: 'DELETE' })
      watchId.value = null
      showToast({ title: 'Removed from watchlist', icon: 'success' })
    } else {
      // For non-barangay/non-city targets, omit the optional alert_types
      // and let the DB defaults apply. For barangays we filter the
      // alerts to ones that make sense on that target type.
      const alertTypes =
        props.targetType === 'barangay'
          ? ['new_listing_in_watch', 'verified_listing', 'hot_area']
          : props.targetType === 'city'
            ? ['new_listing_in_watch', 'verified_listing', 'fast_moving_inventory']
            : ['new_listing_in_watch', 'verified_listing']

      const res = await $fetch<{ watch: { id: string } }>('/api/me/watches', {
        method: 'POST',
        body: {
          target_type: props.targetType,
          target_id:   String(props.targetId),
          alert_types: alertTypes,
          label:       props.label ?? null,
        },
      })
      watchId.value = res.watch.id
      showToast({ title: 'Added to watchlist', icon: 'success' })
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to update watch',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

const watching = computed(() => watchId.value != null)
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50"
    :class="
      watching
        ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15'
        : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground'
    "
    :disabled="checking || submitting"
    @click="toggle"
    :title="watching ? 'Stop watching this target' : 'Get notifications when activity happens here'"
  >
    <span aria-hidden="true">{{ watching ? '★' : '☆' }}</span>
    <span>{{ checking ? 'Checking…' : (watching ? 'Watching' : 'Watch') }}</span>
  </button>
</template>
