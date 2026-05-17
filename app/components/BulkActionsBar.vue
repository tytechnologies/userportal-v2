<script setup lang="ts">
// Floating action bar shown when ≥1 listing is selected. Sits above the
// pagination row (sticky-bottom pattern) so it stays visible while the
// user scrolls a long table. Mounted by the listings page; controls are
// emitted up so the page owns the actual API calls + toast wiring.
//
// Phase 4: every destructive button is hidden unless can() allows it for
// the caller's role. The server still re-checks via RLS — these are UX
// hints, not security gates.
//
// Buttons disable during inflight ops to prevent double-submits.
import { computed } from 'vue'
import { canRef } from '~/composables/useAuth'

const props = defineProps<{
  count: number
  // True while any bulk operation is currently running. Disables every
  // action button and swaps the primary label for a busy state.
  busy?: boolean
}>()

const canBulk = canRef('bulk_actions')
const canArchive = canRef('archive_listing')
const canDelete = canRef('delete_listing')

const emit = defineEmits<{
  (e: 'archive'): void
  (e: 'unarchive'): void
  (e: 'softDelete'): void
  (e: 'clear'): void
}>()

const label = computed(() =>
  props.count === 1 ? '1 listing selected' : `${props.count} listings selected`,
)
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-150 ease-out"
    enter-from-class="opacity-0 translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition-all duration-100 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="count > 0 && canBulk"
      class="sticky bottom-4 z-30 mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-card px-4 py-3 shadow-lg"
      role="region"
      aria-label="Bulk actions"
    >
      <span class="text-sm font-semibold text-foreground">{{ label }}</span>

      <div class="flex flex-1 flex-wrap justify-end gap-2">
        <button
          v-if="canArchive"
          type="button"
          class="rounded-lg bg-muted px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="busy"
          @click="emit('archive')"
        >
          Archive
        </button>
        <button
          v-if="canArchive"
          type="button"
          class="rounded-lg bg-muted px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="busy"
          @click="emit('unarchive')"
        >
          Unarchive
        </button>
        <button
          v-if="canDelete"
          type="button"
          class="rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="busy"
          @click="emit('softDelete')"
        >
          Delete
        </button>
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="busy"
          @click="emit('clear')"
        >
          Cancel
        </button>
      </div>

      <span v-if="busy" class="text-xs text-muted-foreground">Working…</span>
    </div>
  </Transition>
</template>
