<script setup lang="ts">
/**
 * UiPageHeader — top-level h1 for a page (Operations palette).
 *
 * The pattern: optional breadcrumb / back link → page title +
 * inline action cluster → optional description below. Tighter than
 * the editorial-era page header — title and actions on the same row,
 * description sits as a sub-line.
 *
 * Use as the FIRST child of an AdminPageShell (or any page
 * container). Pairs with UiSectionHeader for nested sections.
 */
defineProps<{
  title: string
  description?: string
  /** Optional breadcrumb-style "← Back to X" trail. */
  back?: { label: string; to: string }
  /** Optional eyebrow above the title (e.g., section / domain). */
  eyebrow?: string
}>()
</script>

<template>
  <header class="flex flex-col gap-3 border-b border-border pb-4">
    <NuxtLink
      v-if="back"
      :to="back.to"
      class="inline-flex items-center gap-1 text-meta hover:text-foreground"
    >
      <span aria-hidden="true">←</span>
      {{ back.label }}
    </NuxtLink>
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0 flex-1">
        <p v-if="eyebrow" class="text-eyebrow mb-1">{{ eyebrow }}</p>
        <h1 class="text-page-title">{{ title }}</h1>
        <p
          v-if="description"
          class="mt-1 max-w-2xl text-sm text-muted-foreground"
        >
          {{ description }}
        </p>
        <div
          v-else-if="$slots.description"
          class="mt-1 max-w-2xl text-sm text-muted-foreground"
        >
          <slot name="description" />
        </div>
      </div>
      <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2 shrink-0">
        <slot name="actions" />
      </div>
    </div>
  </header>
</template>
