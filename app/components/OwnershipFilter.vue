<script setup lang="ts">
// Phase 4 ownership-scope filter chips. Three states: All / Mine / Team.
// "Team" only renders for managers/admins — agents have nothing useful to
// show there (RLS already restricts an agent to their own + unowned rows).
//
// Wires into useListingsFilters().ownership; pages can also use it via
// v-model when they don't own the composable.
import { computed } from 'vue'
import { useUserRole } from '~/composables/useAuth'

type Ownership = '' | 'mine' | 'team'

const props = defineProps<{
  modelValue: Ownership
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Ownership): void
}>()

const role = useUserRole()
const canSeeTeam = computed(() => role.value === 'manager' || role.value === 'admin')

const options = computed(() => {
  const base: Array<{ value: Ownership; label: string }> = [
    { value: '', label: 'All visible' },
    { value: 'mine', label: 'My listings' },
  ]
  if (canSeeTeam.value) base.push({ value: 'team', label: 'Team listings' })
  return base
})

const set = (value: Ownership) => emit('update:modelValue', value)
</script>

<template>
  <div
    class="inline-flex items-center gap-1 rounded-lg border border-border bg-background p-1"
    role="radiogroup"
    aria-label="Listing ownership"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value"
      class="rounded-md px-3 py-1 text-xs font-semibold transition-colors"
      :class="
        modelValue === opt.value
          ? 'bg-primary text-white'
          : 'text-muted-foreground hover:bg-muted'
      "
      @click="set(opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
