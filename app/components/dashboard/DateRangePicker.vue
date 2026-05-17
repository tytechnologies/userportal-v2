<script setup lang="ts">
// Shared dashboard date-range picker. Sits in the page header; widgets
// that read useDashboardFilter() refetch when the user changes the
// preset or sets a custom range.
//
// Three presets (7d / 30d / 90d) on a chip strip; "Custom" reveals two
// date inputs and applies on change. Resolves to fromIso/toIso the
// widgets consume.

import { ref, watch } from 'vue'
import { useDashboardFilter } from '~/composables/useDashboardFilter'

const filter = useDashboardFilter()
const isCustomOpen = ref(filter.preset.value === 'custom')

watch(() => filter.preset.value, (p) => {
  if (p !== 'custom') isCustomOpen.value = false
})

function applyCustom() {
  if (filter.customFrom.value && filter.customTo.value) {
    filter.setCustom(filter.customFrom.value, filter.customTo.value)
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <div class="flex gap-1 rounded-lg bg-muted p-1">
      <button
        v-for="opt in ([
          { v: '7d',  label: '7d' },
          { v: '30d', label: '30d' },
          { v: '90d', label: '90d' },
          { v: 'custom', label: 'Custom' },
        ] as const)"
        :key="opt.v"
        type="button"
        class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
        :class="filter.preset.value === opt.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
        @click="filter.setPreset(opt.v); isCustomOpen = opt.v === 'custom'"
      >
        {{ opt.label }}
      </button>
    </div>

    <!-- Custom-range inputs only when the preset is 'custom'. Both
         dates required before we re-apply via setCustom (which also
         pins preset='custom'). -->
    <div v-if="isCustomOpen" class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <input
        type="date"
        class="rounded-md border border-border px-2 py-1 text-xs"
        :value="filter.customFrom.value"
        @change="filter.setCustom(($event.target as HTMLInputElement).value || null, filter.customTo.value)"
      />
      <span class="text-muted-foreground/70">→</span>
      <input
        type="date"
        class="rounded-md border border-border px-2 py-1 text-xs"
        :value="filter.customTo.value"
        @change="filter.setCustom(filter.customFrom.value, ($event.target as HTMLInputElement).value || null)"
      />
      <button
        type="button"
        class="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
        :disabled="!filter.customFrom.value || !filter.customTo.value"
        @click="applyCustom"
      >
        Apply
      </button>
    </div>

    <span class="text-xs text-muted-foreground/70">{{ filter.label.value }}</span>
  </div>
</template>
