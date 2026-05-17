<script setup lang="ts">
/**
 * UiFilterChip — toggleable filter pill with optional count.
 *
 * Operations palette: rectangular (rounded-md) chip with defined
 * borders. Active chip: solid primary fill. Idle: bordered card.
 * Reads as "filter button" rather than "tag pill".
 *
 * Usage:
 *   <UiFilterChip v-model:active="open" :count="12">Open</UiFilterChip>
 *
 * For a single-select group, parent owns the active key and passes
 * `active` as a boolean per chip.
 */
const props = withDefaults(
  defineProps<{
    active?: boolean
    /** Optional count badge inside the chip. */
    count?: number | null
    disabled?: boolean
  }>(),
  {
    active: false,
    count: null,
    disabled: false,
  },
)

defineEmits<{
  (e: 'update:active', v: boolean): void
}>()
</script>

<template>
  <button
    type="button"
    :disabled="disabled"
    :class="[
      'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors duration-100 ease-out focus-ring',
      active
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border bg-card text-foreground hover:border-border-strong hover:bg-accent',
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
    ]"
    @click="$emit('update:active', !active)"
  >
    <slot />
    <span
      v-if="count !== null && count !== undefined"
      :class="[
        'inline-flex min-w-[1.25rem] justify-center rounded px-1.5 text-[10px] font-semibold tabular-nums',
        active
          ? 'bg-primary-foreground/15 text-primary-foreground'
          : 'bg-muted text-muted-foreground',
      ]"
    >
      {{ count }}
    </span>
  </button>
</template>
