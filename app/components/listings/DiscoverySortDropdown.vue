<script setup lang="ts">
/**
 * Discovery sort dropdown.
 *
 * Reads the search_sort_modes registry (anon-readable) and emits
 * the chosen mode_key. Default = the registry's is_default row.
 *
 * Tooltip surfaces each mode's formula doc so power users see what
 * the sort is doing — explainability is the core promise.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type SortMode = {
  mode_key: string
  display_name: string
  description: string | null
  formula_doc: string | null
  is_default: boolean
}

const props = withDefaults(defineProps<{
  modelValue?: string
}>(), {
  modelValue: 'recommended',
})

const emit = defineEmits<{
  (e: 'update:modelValue', mode: string): void
}>()

const supabase = useSupabaseClient()
const modes = ref<SortMode[]>([])
const selected = ref<string>(props.modelValue)

async function load() {
  try {
    const { data, error } = await (supabase as any)
      .from('search_sort_modes')
      .select('mode_key, display_name, description, formula_doc, is_default')
      .eq('enabled', true)
      .order('is_default', { ascending: false })
      .order('mode_key')
    if (error) throw error
    modes.value = (data || []) as SortMode[]

    // If no mode is set in the prop, fall back to the registry default.
    if (!props.modelValue) {
      const def = modes.value.find((m) => m.is_default)
      if (def) {
        selected.value = def.mode_key
        emit('update:modelValue', def.mode_key)
      }
    }
  } catch (err: any) {
    showToast({
      title: err?.message || 'Failed to load sort modes',
      icon: 'error',
    })
  }
}

watch(() => props.modelValue, (v) => {
  if (v && v !== selected.value) selected.value = v
})

watch(selected, (v) => {
  emit('update:modelValue', v)
})

onMounted(load)

const activeMode = computed(() =>
  modes.value.find((m) => m.mode_key === selected.value) ?? null,
)
</script>

<template>
  <div class="flex flex-col gap-1">
    <label class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      Sort
    </label>
    <select
      v-model="selected"
      class="rounded-md border border-border bg-background px-2 py-1 text-sm"
      :title="activeMode?.formula_doc || ''"
    >
      <option v-for="m in modes" :key="m.mode_key" :value="m.mode_key">
        {{ m.display_name }}
      </option>
    </select>
    <p
      v-if="activeMode?.description"
      class="text-[10px] text-muted-foreground"
    >
      {{ activeMode.description }}
    </p>
  </div>
</template>
