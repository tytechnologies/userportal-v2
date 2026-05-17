<script setup lang="ts">
/**
 * UiSectionHeader — h2 for a section inside a page (Operations palette).
 *
 * The pattern: title (left) + optional eyebrow + optional action
 * cluster (right). Tighter than the editorial-era section header.
 *
 * Use INSIDE an AdminPageShell, NOT as the page's top-level header
 * (use UiPageHeader for that).
 *
 * Example:
 *   <UiSectionHeader title="Recent activity" eyebrow="Last 7d">
 *     <template #actions>
 *       <button class="btn-ghost">View all →</button>
 *     </template>
 *   </UiSectionHeader>
 */
defineProps<{
  title: string
  eyebrow?: string
  /** Description below the title. */
  description?: string
}>()
</script>

<template>
  <header class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
    <div class="min-w-0">
      <p v-if="eyebrow" class="text-eyebrow">{{ eyebrow }}</p>
      <h2 :class="[eyebrow ? 'mt-0.5' : '', 'text-section-title']">
        {{ title }}
      </h2>
      <p v-if="description" class="mt-0.5 text-meta">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2 shrink-0">
      <slot name="actions" />
    </div>
  </header>
</template>
