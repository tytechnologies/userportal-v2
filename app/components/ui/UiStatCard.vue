<script setup lang="ts">
/**
 * UiStatCard — KPI / metric card (Operations palette).
 *
 * The Linear/Stripe pattern: small uppercase eyebrow, big tabular
 * value, optional delta below. Optional trailing icon. Optional
 * sparkline / chart slot.
 *
 * Tighter padding + smaller radius than the editorial-era card.
 *
 * Compose into rows with a CSS grid:
 *   <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
 *     <UiStatCard label="..." :value="..." />
 *     ...
 *
 * Loading state: pass `loading` to render shimmer over the value.
 */
import UiSkeleton from './UiSkeleton.vue'

type Tone = 'neutral' | 'success' | 'warning' | 'destructive' | 'primary'

const props = withDefaults(
  defineProps<{
    label: string
    value: string | number | null | undefined
    /** Small subtitle below the value (e.g., "vs last month"). */
    delta?: string | number | null
    /** Tone of the value/delta. Default neutral. */
    tone?: Tone
    /** Direction of the delta — only affects icon, not color. */
    deltaDirection?: 'up' | 'down' | 'flat'
    /** Render a shimmer in place of the value. */
    loading?: boolean
    /** Optional href turns the card into a NuxtLink with hover affordance. */
    to?: string
  }>(),
  {
    delta: null,
    tone: 'neutral',
    deltaDirection: 'flat',
    loading: false,
    to: undefined,
  },
)

const valueToneClass: Record<Tone, string> = {
  neutral: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  primary: 'text-primary',
}
const deltaToneClass: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  primary: 'text-primary',
}

const directionGlyph: Record<'up' | 'down' | 'flat', string> = {
  up: '↑',
  down: '↓',
  flat: '',
}
</script>

<template>
  <component
    :is="to ? 'NuxtLink' : 'div'"
    :to="to"
    :class="[
      'ui-card p-3.5 transition-colors duration-100 ease-out',
      to ? 'hover:border-border-strong hover:bg-accent focus-ring' : '',
    ]"
  >
    <div class="flex items-start justify-between gap-2">
      <p class="text-eyebrow">{{ label }}</p>
      <slot name="trailing" />
    </div>
    <UiSkeleton v-if="loading" class="mt-2 h-7 w-24" />
    <p
      v-else
      :class="['mt-1 text-metric-value', valueToneClass[props.tone]]"
    >
      {{ value ?? '—' }}
    </p>
    <p
      v-if="delta !== null && delta !== undefined && delta !== ''"
      :class="['mt-0.5 text-metric-delta', deltaToneClass[props.tone]]"
    >
      <span v-if="directionGlyph[props.deltaDirection]" class="mr-0.5">{{
        directionGlyph[props.deltaDirection]
      }}</span>
      {{ delta }}
    </p>
    <slot />
  </component>
</template>
