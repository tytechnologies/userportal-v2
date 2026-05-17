<script setup lang="ts">
/**
 * UiToolbar — the row above a list / table that owns filters, search,
 * and primary actions.
 *
 * The Linear / Stripe pattern: a single horizontal strip with three
 * slots:
 *   leading  — search input or filter chips (pushed left)
 *   default  — secondary controls (pushed center, optional)
 *   trailing — primary actions / button group (pushed right)
 *
 * Wraps onto multiple rows on narrow viewports. Sticky variant pins
 * to the top of its scroll container — useful for long lists.
 *
 * Operations palette: solid card surface (NOT page background) with
 * a defined border-bottom. Sticky variant renders against the page
 * scroll container at top-14 (below the global navbar).
 */
withDefaults(
  defineProps<{
    sticky?: boolean
    /** Horizontal padding for the toolbar interior. */
    padding?: 'none' | 'sm' | 'md'
    /** Render with rounded corners + border for stand-alone use.
     *  Default: flush (no radius / no left+right border) for use as
     *  a header inside a UiCard or page chrome. */
    bordered?: boolean
  }>(),
  {
    sticky: false,
    padding: 'md',
    bordered: false,
  },
)
</script>

<template>
  <div
    :class="[
      'flex flex-wrap items-center gap-2 bg-card',
      bordered ? 'rounded-lg border border-border' : 'border-b border-border-strong',
      sticky ? 'sticky top-14 z-20' : '',
      padding === 'md'
        ? 'px-4 py-2.5'
        : padding === 'sm'
          ? 'px-3 py-2'
          : '',
    ]"
  >
    <div v-if="$slots.leading" class="flex flex-wrap items-center gap-2">
      <slot name="leading" />
    </div>
    <div v-if="$slots.default" class="flex flex-wrap items-center gap-2">
      <slot />
    </div>
    <div v-if="$slots.trailing" class="ml-auto flex flex-wrap items-center gap-2">
      <slot name="trailing" />
    </div>
  </div>
</template>
