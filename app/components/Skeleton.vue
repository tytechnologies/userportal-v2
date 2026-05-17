<script setup lang="ts">
/**
 * Skeleton primitive — a single animated placeholder block.
 *
 * Usage: <Skeleton class="h-4 w-32" />
 *
 * Replaces ad-hoc `animate-pulse rounded bg-muted` strings sprinkled
 * across the codebase. Caller controls dimensions via class — the
 * component just supplies the animation + neutral fill.
 */

defineProps<{
  /** Optional explicit shape override. Default is "block" (rectangle).
   *  "circle" ensures rounded-full + 1:1 ratio for avatar placeholders. */
  shape?: 'block' | 'circle'
}>()
</script>

<template>
  <span
    class="block animate-pulse bg-muted-foreground/15"
    :class="shape === 'circle' ? 'aspect-square rounded-full' : 'rounded-md'"
    aria-hidden="true"
  />
</template>
