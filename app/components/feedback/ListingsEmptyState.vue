<script setup lang="ts">
// Empty-state placeholder for the listings table. Shown when a fetch
// succeeds but returns zero rows. Variant `filtered` swaps the copy +
// primary CTA so users see "Clear filters" instead of "Create listing"
// when their narrow filter accidentally hides everything.
//
// Slot-in: <ListingsEmptyState :filtered="hasAny" @clear="reset" @create="..." />
import { computed } from 'vue'

const props = defineProps<{
  filtered?: boolean
}>()

const emit = defineEmits<{
  (e: 'clear'): void
  (e: 'create'): void
}>()

const title = computed(() =>
  props.filtered ? 'No listings match these filters' : 'No listings yet',
)

const subtitle = computed(() =>
  props.filtered
    ? 'Try widening your filters or clearing them to see more results.'
    : 'Get started by creating your first listing.',
)
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center py-16 px-6 gap-3"
    role="status"
    aria-live="polite"
  >
    <!-- Decorative icon. Stroke-only so it inherits text color. -->
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="w-12 h-12 text-foreground mb-2"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M3 7.5 12 3l9 4.5M3 7.5v9L12 21l9-4.5v-9M3 7.5l9 4.5m0 0 9-4.5m-9 4.5V21"
      />
    </svg>

    <h3 class="text-base font-semibold text-foreground">{{ title }}</h3>
    <p class="text-sm text-muted-foreground max-w-sm">{{ subtitle }}</p>

    <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
      <button
        v-if="filtered"
        type="button"
        class="px-4 py-2 text-sm font-semibold rounded-lg bg-muted text-foreground hover:bg-muted transition-colors"
        @click="emit('clear')"
      >
        Clear filters
      </button>
      <button
        v-else
        type="button"
        class="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        @click="emit('create')"
      >
        Create listing
      </button>
    </div>
  </div>
</template>
