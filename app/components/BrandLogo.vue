<script setup lang="ts">
// Brand mark: "HI" monogram in a brass-tinted rounded square.
//
// Replaces the previous /img/light.png + /img/dark.png wordmark.
// Text-based mark renders crisp at any size, theme-adapts via CSS
// tokens, and drops two binary assets from the bundle. Consumers
// keep controlling size with a height class (e.g. `class="h-9"`);
// the mark stays square via `aspect-square`.

defineProps<{
  /** Optional override label. Falls back to the brand name. */
  alt?: string
}>()
</script>

<template>
  <span
    :aria-label="alt ?? 'Housing Interactive'"
    role="img"
    class="inline-flex aspect-square items-center justify-center rounded-md bg-brass font-bold tracking-tight text-primary-foreground select-none"
    style="font-size: 0.55em; line-height: 1"
  >
    HI
  </span>
</template>
