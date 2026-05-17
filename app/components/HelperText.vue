<script setup lang="ts">
/**
 * HelperText — error / hint message under a form field.
 *
 * Operations palette: text-destructive on error, text-meta otherwise.
 * Two prop variants for back-compat:
 *   value   — generic message (used by some legacy callers)
 *   error   — explicit error message (preferred; flips to destructive)
 */
defineProps<{
  value?: string
  error?: string
  invalid?: boolean
}>()
</script>

<template>
  <span
    v-if="!!error || !!value"
    class="mt-1 inline-block text-xs"
    :class="invalid || !!error ? 'text-destructive' : 'text-muted-foreground'"
  >
    {{ error || value }}
  </span>
</template>
