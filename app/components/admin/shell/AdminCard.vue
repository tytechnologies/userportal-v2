<script setup lang="ts">
/**
 * AdminCard — uniform panel surface.
 *
 * Replaces the recurring `rounded-lg border border-border bg-background
 * p-5  ` pattern with a token-based
 * one-liner. Dark mode is automatic via --card / --border CSS vars.
 *
 * Props:
 *   padding — Tailwind padding token. Default 'p-5'. Pass 'none' for
 *             zero (e.g. tables that want a flush edge).
 *   bordered — set to false to drop the border (e.g. nested cards).
 */
withDefaults(
  defineProps<{
    padding?: string
    bordered?: boolean
  }>(),
  {
    padding: 'p-5',
    bordered: true,
  },
)
</script>

<template>
  <section
    :class="[
      'rounded-lg bg-card text-card-foreground',
      bordered ? 'border border-border' : '',
      padding === 'none' ? '' : padding,
    ]"
  >
    <slot />
  </section>
</template>
