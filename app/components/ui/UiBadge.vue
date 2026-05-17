<script setup lang="ts">
/**
 * UiBadge — pill / status indicator (Operations palette).
 *
 * Variants map onto the semantic tokens, so dark mode is automatic
 * and color meaning is consistent across the app:
 *   neutral     — solid muted bg, body text
 *   primary     — solid surface, primary text + 1px primary border
 *   success     — positive / completed
 *   warning     — caution / pending
 *   destructive — error / blocked
 *   info        — neutral-info (alias of primary tint)
 *
 * Sizes:
 *   xs (default) — uppercase tracking, table cells
 *   sm           — sentence case, cards
 *   md           — standalone status, hero
 *
 * `dot` prop adds a leading colored dot for status pills.
 *
 * Operations palette uses solid-tint variants (not /15 alpha) plus a
 * 1px colored border, so badges read as defined chips even at small
 * sizes and against any surface. No "washed out" feel.
 */
type Variant = 'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'info'
type Size = 'xs' | 'sm' | 'md'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: Size
    dot?: boolean
    /** Use the rectangular (rounded-md) variant instead of the pill
     *  default. Reads more "tag" than "status". */
    square?: boolean
  }>(),
  {
    variant: 'neutral',
    size: 'xs',
    dot: false,
    square: false,
  },
)

const variantClass: Record<Variant, string> = {
  neutral: 'border border-border bg-muted text-foreground',
  primary: 'border border-primary/20 bg-primary/10 text-primary',
  success: 'border border-success/25 bg-success/10 text-success',
  warning: 'border border-warning/30 bg-warning/10 text-warning',
  destructive: 'border border-destructive/25 bg-destructive/10 text-destructive',
  info: 'border border-primary/15 bg-primary/[0.06] text-primary',
}

const dotClass: Record<Variant, string> = {
  neutral: 'bg-muted-foreground',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-primary',
}

const sizeClass: Record<Size, string> = {
  xs: 'px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
  sm: 'px-2 py-0.5 text-xs font-medium',
  md: 'px-2.5 py-1 text-xs font-semibold',
}
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-1.5 whitespace-nowrap',
      square ? 'rounded' : 'rounded-full',
      variantClass[props.variant],
      sizeClass[props.size],
    ]"
  >
    <span
      v-if="dot"
      :class="['h-1.5 w-1.5 rounded-full', dotClass[props.variant]]"
    />
    <slot />
  </span>
</template>
