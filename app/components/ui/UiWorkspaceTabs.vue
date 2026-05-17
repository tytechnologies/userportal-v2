<script setup lang="ts">
/**
 * Sticky-top tab strip for workspace pages — long detail pages where
 * the broker needs to navigate between many panels without scroll
 * fatigue.
 *
 * Differences from UiTabBar:
 *   - Sticky to the top of the scroll container (TabBar is inline)
 *   - Optional badge per tab (counts of open items, errors, etc.)
 *   - Minimal model: tab id, label, optional count, optional severity
 *   - Active state mirrors the rest of the Operations palette
 *
 * The component is presentational — parent owns active state via
 * v-model.
 */
import { computed } from 'vue'

export type WorkspaceTab = {
  id: string
  label: string
  /** Numeric badge appended after the label. Falsy values hide it. */
  count?: number | null
  /** Tints the badge: error / warning / neutral / success / primary. */
  severity?: 'error' | 'warning' | 'neutral' | 'success' | 'primary'
  /** Disable a tab — useful for "n/a until the prerequisite step". */
  disabled?: boolean
}

const props = defineProps<{
  modelValue: string
  tabs: WorkspaceTab[]
  /** Optional aria-label for the tablist. Defaults to "Workspace tabs". */
  ariaLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

function pick(t: WorkspaceTab) {
  if (t.disabled) return
  if (t.id === props.modelValue) return
  emit('update:modelValue', t.id)
}

const badgeClasses: Record<NonNullable<WorkspaceTab['severity']>, string> = {
  error:    'bg-destructive/15 text-destructive',
  warning:  'bg-warning/20 text-warning',
  primary:  'bg-primary/15 text-primary',
  success:  'bg-success/15 text-success',
  neutral:  'bg-muted text-muted-foreground',
}
</script>

<template>
  <div
    role="tablist"
    :aria-label="ariaLabel || 'Workspace tabs'"
    class="sticky top-0 z-20 -mx-4 mb-4 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80"
  >
    <div class="flex flex-wrap gap-1 overflow-x-auto py-2">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="t.id === modelValue"
        :disabled="t.disabled"
        :class="[
          'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-ring whitespace-nowrap',
          t.id === modelValue
            ? 'bg-primary text-primary-foreground'
            : t.disabled
              ? 'text-muted-foreground/50 cursor-not-allowed'
              : 'text-foreground hover:bg-accent',
        ]"
        @click="pick(t)"
      >
        <span>{{ t.label }}</span>
        <span
          v-if="t.count != null && t.count > 0"
          :class="['rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
            t.id === modelValue
              ? 'bg-primary-foreground/20 text-primary-foreground'
              : badgeClasses[t.severity || 'neutral']
          ]"
        >
          {{ t.count }}
        </span>
      </button>
    </div>
  </div>
</template>
