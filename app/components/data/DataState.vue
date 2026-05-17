<script setup lang="ts">
/**
 * Standard wrapper for any list/detail surface. Renders loading, empty,
 * error, or content states with sensible defaults; each is overridable
 * via a named slot.
 *
 * <DataState :status="status" :error="error" :on-retry="refresh"
 *   empty-title="No listings yet"
 *   empty-description="Add your first listing to see it here.">
 *   <ListingsTable :listings="data" />
 * </DataState>
 *
 * Slots:
 *   default          — content shown when status === 'ok'
 *   loading          — override for the loading skeleton
 *   empty            — override for the empty state
 *   empty-cta        — slot inside the default empty state for a CTA button
 *   error            — override for the error state
 */
import Skeleton from '~/components/Skeleton.vue'

withDefaults(
  defineProps<{
    status: 'loading' | 'empty' | 'error' | 'ok'
    error?: { message?: string } | string | null
    emptyTitle?: string
    emptyDescription?: string
    onRetry?: () => void
  }>(),
  {
    error: null,
    emptyTitle: 'Nothing here yet',
    emptyDescription: '',
    onRetry: undefined,
  },
)
</script>

<template>
  <slot v-if="status === 'ok'" />

  <slot v-else-if="status === 'loading'" name="loading">
    <div class="space-y-3 p-4">
      <Skeleton class="h-4 w-1/3" />
      <Skeleton class="h-4 w-2/3" />
      <Skeleton class="h-4 w-1/2" />
      <Skeleton class="h-4 w-3/4" />
    </div>
  </slot>

  <slot v-else-if="status === 'empty'" name="empty">
    <div class="flex flex-col items-center justify-center text-center px-6 py-12">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="mb-4 h-10 w-10 text-muted-foreground"
        aria-hidden="true"
      >
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
      </svg>
      <h3 class="text-base font-semibold text-foreground">{{ emptyTitle }}</h3>
      <p v-if="emptyDescription" class="mt-1 text-sm text-muted-foreground max-w-sm">
        {{ emptyDescription }}
      </p>
      <div class="mt-4">
        <slot name="empty-cta" />
      </div>
    </div>
  </slot>

  <slot v-else-if="status === 'error'" name="error">
    <div class="flex flex-col items-center justify-center text-center px-6 py-12">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="mb-4 h-10 w-10 text-destructive"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <h3 class="text-base font-semibold text-foreground">Something went wrong</h3>
      <p class="mt-1 text-sm text-muted-foreground max-w-sm">
        {{ typeof error === 'string' ? error : (error?.message ?? 'Please try again.') }}
      </p>
      <button
        v-if="onRetry"
        type="button"
        class="mt-4 inline-flex items-center justify-center rounded-md border border-input bg-background px-4 h-9 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="onRetry"
      >
        Try again
      </button>
    </div>
  </slot>
</template>
