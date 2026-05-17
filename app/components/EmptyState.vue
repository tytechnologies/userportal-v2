<script setup lang="ts">
/**
 * Shared empty-state primitive.
 *
 * One visual treatment, three semantic variants:
 *   - 'success' — emerald check chip ("All clear")
 *   - 'neutral' — muted icon chip ("No data yet")
 *   - 'error'   — red triangle chip ("Something went wrong")
 *
 * Usage:
 *   <EmptyState
 *     variant="success"
 *     title="All clear"
 *     description="Nothing needs immediate review."
 *   />
 *
 * Custom icon via slot:
 *   <EmptyState title="No listings yet">
 *     <template #icon><MyIcon :size="22" /></template>
 *     <template #cta>
 *       <button>Add a listing</button>
 *     </template>
 *   </EmptyState>
 */
import { computed } from 'vue'
import CheckCircle from 'vue-material-design-icons/CheckCircle.vue'
import InboxArrowDown from 'vue-material-design-icons/InboxArrowDown.vue'
import AlertCircle from 'vue-material-design-icons/AlertCircle.vue'

const props = withDefaults(
  defineProps<{
    variant?: 'success' | 'neutral' | 'error'
    title: string
    description?: string
    /** Vertical padding intensity. Use 'compact' inside cards that
     *  already have padding; default 'cozy' adds breathing room. */
    size?: 'compact' | 'cozy'
  }>(),
  {
    variant: 'neutral',
    size: 'cozy',
  },
)

const chipClass = computed(() => {
  switch (props.variant) {
    case 'success':
      return 'bg-success/10 text-success ring-success/30'
    case 'error':
      return 'bg-destructive/10 text-destructive ring-destructive/30'
    case 'neutral':
    default:
      return 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/15'
  }
})

const defaultIcon = computed(() => {
  switch (props.variant) {
    case 'success':
      return CheckCircle
    case 'error':
      return AlertCircle
    case 'neutral':
    default:
      return InboxArrowDown
  }
})

const padClass = computed(() =>
  props.size === 'compact' ? 'py-6' : 'py-10',
)
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-2 text-center"
    :class="padClass"
  >
    <div
      class="rounded-full p-3 ring-1"
      :class="chipClass"
    >
      <slot name="icon">
        <component :is="defaultIcon" :size="22" />
      </slot>
    </div>
    <p class="text-sm font-semibold text-foreground">{{ title }}</p>
    <p
      v-if="description"
      class="max-w-xs text-xs text-muted-foreground"
    >
      {{ description }}
    </p>
    <div v-if="$slots.cta" class="mt-2">
      <slot name="cta" />
    </div>
  </div>
</template>
