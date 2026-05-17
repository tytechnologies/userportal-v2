<script setup lang="ts">
/**
 * UiCard — the canonical surface primitive (Operations palette).
 *
 * Variants:
 *   surface     — standard panel (border + bg-card, NO shadow)
 *   elevated    — sits above body content (border + soft shadow)
 *   ghost       — bg only, no border (for nested groupings)
 *   interactive — surface + hover affordance
 *   inset       — recessed surface (bg-surface-2) for nested density
 *
 * Padding props use the design rhythm:
 *   none | sm (p-3) | md (p-4, default) | lg (p-5)
 *
 * Use this everywhere instead of hand-rolled
 *   `rounded-lg border border-border bg-card p-4`
 * The class chain shows up identically across pages.
 */
type Variant = 'surface' | 'elevated' | 'ghost' | 'interactive' | 'inset'
type Padding = 'none' | 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    padding?: Padding
    /** When set, the card is a button — fires the `click` event. */
    clickable?: boolean
  }>(),
  {
    variant: 'surface',
    padding: 'md',
    clickable: false,
  },
)

defineEmits<{
  (e: 'click', ev: MouseEvent): void
}>()

const variantClass: Record<Variant, string> = {
  surface: 'ui-card',
  elevated: 'ui-card shadow-[0_1px_2px_rgba(15,23,42,0.04),0_2px_8px_-2px_rgba(15,23,42,0.06)]',
  ghost: 'rounded-lg bg-card text-card-foreground',
  interactive: 'ui-card-interactive cursor-pointer',
  inset: 'rounded-lg border border-border bg-surface-2 text-foreground',
}
const paddingClass: Record<Padding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
}
</script>

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    :class="[variantClass[props.variant], paddingClass[props.padding], clickable ? 'text-left focus-ring' : '']"
    @click="$emit('click', $event)"
  >
    <slot />
  </component>
</template>
