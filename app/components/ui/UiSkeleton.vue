<script setup lang="ts">
/**
 * UiSkeleton — shimmer placeholder.
 *
 * Use as a direct replacement for the value/copy that's loading.
 * The shimmer is a subtle pulse — animations are tuned to be
 * un-distracting, per the "lightweight motion" mandate.
 *
 * Sizing: pass any Tailwind size classes (h-4, w-32, etc.).
 * Default is h-4 w-full so a bare `<UiSkeleton />` collapses to a
 * sentence-height bar.
 */
withDefaults(
  defineProps<{
    /** Render as a circle (avatar/icon shimmer). */
    circle?: boolean
  }>(),
  { circle: false },
)
</script>

<template>
  <div
    :class="[
      'animate-pulse bg-muted',
      circle ? 'rounded-full' : 'rounded-md',
      // Default sizing if no h-/w- classes were supplied via parent.
      'h-4 w-full',
    ]"
    aria-hidden="true"
  />
</template>
