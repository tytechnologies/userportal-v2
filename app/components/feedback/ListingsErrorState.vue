<script setup lang="ts">
// In-page error banner for the listings table. Replaces the previous
// blocking Swal modal that forced a full page reload — that flow lost
// any URL-synced filters the user had set.
//
// Usage:
//   <ListingsErrorState
//     v-if="errorMessage"
//     :message="errorMessage"
//     @retry="getListings"
//   />
//
// `message` is shown as-is. The retry button is the primary action;
// fall back to a "reload" link only if the parent doesn't supply a
// retry handler (rare).
import { computed } from 'vue'

const props = defineProps<{
  message?: string
  // True while a retry attempt is in flight; disables the button to
  // prevent double-submits.
  retrying?: boolean
}>()

const emit = defineEmits<{
  (e: 'retry'): void
}>()

const displayMessage = computed(
  () => props.message || 'Something went wrong loading the listings.',
)
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center py-16 px-6 gap-3"
    role="alert"
    aria-live="assertive"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="w-12 h-12 text-destructive mb-2"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 9v3.75m0 3.001v.001M9.401 4.32 1.91 17.32A1.875 1.875 0 0 0 3.502 20.25h16.996a1.875 1.875 0 0 0 1.591-2.93l-7.491-13a1.875 1.875 0 0 0-3.197 0Z"
      />
    </svg>

    <h3 class="text-base font-semibold text-foreground">Couldn't load listings</h3>
    <p class="text-sm text-muted-foreground max-w-md">{{ displayMessage }}</p>

    <button
      type="button"
      class="mt-3 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      :disabled="retrying"
      @click="emit('retry')"
    >
      <span v-if="retrying">Retrying…</span>
      <span v-else>Try again</span>
    </button>
  </div>
</template>
