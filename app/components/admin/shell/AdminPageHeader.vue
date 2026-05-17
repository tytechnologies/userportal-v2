<script setup lang="ts">
/**
 * AdminPageHeader — consistent h1 + lede + optional action slot.
 *
 * Slot `actions` renders aligned-right buttons. Slot `default` is the
 * description body (so descriptions can include inline links/code).
 *
 * Tokens-only: text-foreground / text-muted-foreground.
 */
defineProps<{
  title: string
}>()
</script>

<template>
  <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <h1 class="text-page-title">{{ title }}</h1>
      <p
        v-if="$slots.default"
        class="mt-1 text-sm text-muted-foreground"
      >
        <slot />
      </p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
