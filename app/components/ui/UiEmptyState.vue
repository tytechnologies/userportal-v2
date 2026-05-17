<script setup lang="ts">
/**
 * UiEmptyState — contextual "nothing here yet" placeholder.
 *
 * Operations palette: solid card surface (NOT dashed), tight padding,
 * left-aligned by default for use INSIDE a section. Centered prop
 * for use as the body of an otherwise-empty page.
 *
 * Slots:
 *   icon   — optional leading icon component
 *   action — primary action button(s)
 */
withDefaults(
  defineProps<{
    title: string
    description?: string
    /** Center-align the contents. Default: left-aligned for in-section use. */
    centered?: boolean
  }>(),
  {
    centered: false,
  },
)
</script>

<template>
  <div
    :class="[
      'ui-card flex flex-col gap-3 px-5 py-8',
      centered ? 'items-center text-center' : 'items-start text-left',
    ]"
  >
    <div v-if="$slots.icon" class="text-muted-foreground/70">
      <slot name="icon" />
    </div>
    <div :class="centered ? 'space-y-1.5' : 'space-y-1'">
      <p class="text-card-title">{{ title }}</p>
      <p
        v-if="description"
        :class="['text-meta', centered ? 'mx-auto max-w-md' : 'max-w-md']"
      >
        {{ description }}
      </p>
    </div>
    <div
      v-if="$slots.action"
      :class="['flex flex-wrap items-center gap-2', centered ? 'justify-center' : '']"
    >
      <slot name="action" />
    </div>
  </div>
</template>
