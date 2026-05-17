<script setup lang="ts" generic="T extends string | number">
/**
 * UiTabBar — segmented control / page-level tab strip.
 *
 * Operations palette: underline tabs at page level (Linear/Stripe);
 * pill tabs inside cards (segmented control).
 *
 *   underline (default) — bottom border on active tab, page level
 *   pill                — segmented control inside cards / toolbars
 *
 * Usage:
 *   <UiTabBar
 *     v-model="active"
 *     :tabs="[
 *       { value: 'all', label: 'All', count: 124 },
 *       { value: 'open', label: 'Open', count: 12 },
 *       { value: 'closed', label: 'Closed' },
 *     ]"
 *   />
 *
 * v-model is the active value. Optional `count` per tab renders a
 * subtle badge.
 */
type Tab = {
  value: T
  label: string
  count?: number | null
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: T
    tabs: Tab[]
    variant?: 'underline' | 'pill'
    /** Render full-bleed (border-b on the strip itself) for page-level use. */
    underlineFull?: boolean
  }>(),
  {
    variant: 'underline',
    underlineFull: false,
  },
)

defineEmits<{
  (e: 'update:modelValue', v: T): void
}>()

const isPill = props.variant === 'pill'
</script>

<template>
  <div
    role="tablist"
    :class="[
      'flex flex-wrap items-end gap-1',
      isPill
        ? 'rounded-md border border-border bg-surface-2 p-1'
        : underlineFull
          ? 'border-b border-border-strong'
          : '',
    ]"
  >
    <button
      v-for="tab in tabs"
      :key="String(tab.value)"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.value"
      :disabled="tab.disabled"
      :class="[
        'group inline-flex items-center gap-1.5 transition-colors duration-100 ease-out focus-ring',
        tab.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        isPill
          ? [
              'h-7 rounded px-3 text-xs font-medium',
              modelValue === tab.value
                ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            ]
          : [
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              modelValue === tab.value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
            ],
      ]"
      @click="$emit('update:modelValue', tab.value)"
    >
      <span>{{ tab.label }}</span>
      <span
        v-if="tab.count !== null && tab.count !== undefined"
        :class="[
          'inline-flex min-w-[1.25rem] justify-center rounded px-1.5 text-[10px] font-semibold tabular-nums',
          modelValue === tab.value
            ? 'bg-primary/10 text-primary'
            : 'bg-muted text-muted-foreground',
        ]"
      >
        {{ tab.count }}
      </span>
    </button>
  </div>
</template>
