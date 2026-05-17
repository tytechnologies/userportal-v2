<script setup lang="ts">
// Generic click-to-edit cell. Renders a static display by default; clicking
// swaps in a text input or <select>. Enter / blur saves; Escape cancels.
//
// The component is *presentational* — it does NOT call any API. The parent
// owns the save flow:
//   - Optimistic update happens via `:modelValue` from the parent's local
//     state.
//   - On save, the component emits @save with the new value. The parent
//     calls its API and either keeps the optimistic value or reverts and
//     shows an error toast.
//
// Usage:
//   <InlineEditCell
//     :modelValue="row.status.value"
//     :displayValue="row.status.label"
//     :options="STATUS_OPTIONS"
//     @save="(next) => onSaveStatus(row.id, next)"
//   />
//
// `displayValue` lets the parent show a human label that differs from the
// raw value (e.g. 'AVAILABLE' for value 'available'). Defaults to
// `modelValue` when omitted.
import { computed, nextTick, ref, watch } from 'vue'

type SelectOption = { label: string; value: string | number }

const props = defineProps<{
  modelValue: string | number | null | undefined
  displayValue?: string
  // Inline editing mode. 'select' renders a <select>; 'text' renders a
  // text <input>; 'number' renders a numeric input.
  mode?: 'select' | 'text' | 'number'
  // Required when mode === 'select'.
  options?: SelectOption[]
  // When true the cell renders read-only (no click-to-edit). Useful for
  // permission gating.
  disabled?: boolean
  // CSS class applied to the static label. Lets the parent keep its
  // existing pill / chip styling.
  displayClass?: string
  // Placeholder for empty values.
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'save', value: string | number): void
  (e: 'cancel'): void
}>()

const editing = ref(false)
const draft = ref<string | number>(props.modelValue ?? '')
const inputEl = ref<HTMLInputElement | HTMLSelectElement | null>(null)

watch(
  () => props.modelValue,
  (next) => {
    if (!editing.value) draft.value = next ?? ''
  },
)

const labelText = computed(() => {
  if (props.displayValue !== undefined) return props.displayValue
  if (props.modelValue == null || props.modelValue === '') return props.placeholder || '—'
  return String(props.modelValue)
})

const start = () => {
  if (props.disabled) return
  draft.value = props.modelValue ?? ''
  editing.value = true
  // Focus + select on next tick so the user can immediately overwrite.
  nextTick(() => {
    inputEl.value?.focus()
    if (inputEl.value && 'select' in inputEl.value) {
      ;(inputEl.value as HTMLInputElement).select?.()
    }
  })
}

const cancel = () => {
  editing.value = false
  draft.value = props.modelValue ?? ''
  emit('cancel')
}

const commit = () => {
  if (!editing.value) return
  editing.value = false
  // No-op when the value didn't change — saves a wasted API call.
  if (draft.value === props.modelValue) return
  emit('save', draft.value)
}

const handleKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    commit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}
</script>

<template>
  <div class="inline-edit-cell">
    <button
      v-if="!editing"
      type="button"
      class="cursor-pointer text-left disabled:cursor-not-allowed"
      :class="displayClass"
      :disabled="props.disabled"
      :title="props.disabled ? '' : 'Click to edit'"
      @click="start"
    >
      {{ labelText }}
    </button>

    <select
      v-else-if="props.mode === 'select'"
      ref="inputEl"
      v-model="draft"
      class="rounded border border-primary/30 bg-card px-2 py-1 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-primary/30"
      @keydown="handleKey"
      @blur="commit"
      @change="commit"
    >
      <option
        v-for="opt in props.options ?? []"
        :key="String(opt.value)"
        :value="opt.value"
      >
        {{ opt.label }}
      </option>
    </select>

    <input
      v-else
      ref="inputEl"
      v-model="draft"
      :type="props.mode === 'number' ? 'number' : 'text'"
      class="w-full rounded border border-primary/30 bg-card px-2 py-1 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-primary/30"
      @keydown="handleKey"
      @blur="commit"
    />
  </div>
</template>
