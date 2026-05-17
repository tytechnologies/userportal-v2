<script setup lang="ts">
/**
 * UserPicker — debounced typeahead for picking a single profile (uuid).
 *
 * Calls /api/profiles/search?q=… and v-model's the selected profile id.
 * Used wherever a uuid input would otherwise dump the cognitive load
 * on the operator (admin org setup forms, deal participants, future
 * task assignment, etc.).
 *
 * v-model returns the picked profile's id (string) or '' when cleared.
 * Emits `picked` with the full row when selected — handy when the
 * caller also wants to display the name without a second fetch.
 */
import { ref, watch, computed } from 'vue'

type Profile = {
  id: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    /** Optional pre-fill when the parent already knows the user (edit
     *  flow). Component shows their name without a search round-trip. */
    initialProfile?: Profile | null
    /** When set, refuse to surface results matching this id (e.g.,
     *  hide self in a "pick a teammate" picker). */
    excludeId?: string | null
    disabled?: boolean
    /** Render inside grids — fill width by default, but caller can opt out. */
    block?: boolean
  }>(),
  {
    placeholder: 'Search by name or email…',
    initialProfile: null,
    excludeId: null,
    disabled: false,
    block: true,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'picked', profile: Profile | null): void
}>()

const picked = ref<Profile | null>(props.initialProfile)
const search = ref(
  props.initialProfile ? (props.initialProfile.full_name || props.initialProfile.email || '') : '',
)
const searching = ref(false)
const results = ref<Profile[]>([])
const showResults = ref(false)
let seq = 0
let typeTimer: ReturnType<typeof setTimeout> | null = null

async function runSearch() {
  const q = search.value.trim()
  if (q.length < 2) {
    results.value = []
    return
  }
  searching.value = true
  const mySeq = ++seq
  try {
    const res = await $fetch<{ items: Profile[] }>('/api/profiles/search', {
      query: { q, limit: 8 },
    })
    if (mySeq !== seq) return
    let items = res.items ?? []
    if (props.excludeId) items = items.filter((p) => p.id !== props.excludeId)
    results.value = items
    showResults.value = true
  } catch {
    if (mySeq === seq) results.value = []
  } finally {
    if (mySeq === seq) searching.value = false
  }
}

watch(search, (v) => {
  if (typeTimer) clearTimeout(typeTimer)
  if (!v.trim()) {
    results.value = []
    showResults.value = false
    if (picked.value) {
      picked.value = null
      emit('update:modelValue', '')
      emit('picked', null)
    }
    return
  }
  // If the user types away from the picked label, drop the selection.
  if (picked.value && v !== (picked.value.full_name || picked.value.email || '')) {
    picked.value = null
    emit('update:modelValue', '')
    emit('picked', null)
  }
  typeTimer = setTimeout(runSearch, 220)
})

function pick(p: Profile) {
  picked.value = p
  search.value = p.full_name || p.email || p.id.slice(0, 8)
  showResults.value = false
  emit('update:modelValue', p.id)
  emit('picked', p)
}

const showStatusLine = computed(
  () => searching.value || picked.value || (search.value.length >= 2 && results.value.length === 0 && !searching.value),
)
</script>

<template>
  <div :class="[block ? 'relative w-full' : 'relative inline-block']">
    <input
      v-model="search"
      :disabled="disabled"
      type="text"
      autocomplete="off"
      :placeholder="placeholder"
      class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      @focus="showResults = results.length > 0"
    />
    <ul
      v-if="showResults && results.length > 0"
      class="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
    >
      <li v-for="r in results" :key="r.id">
        <button
          type="button"
          class="block w-full px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
          @click="pick(r)"
        >
          <span class="block truncate font-medium">{{ r.full_name || r.email || `Profile ${r.id.slice(0, 8)}…` }}</span>
          <span v-if="r.email && r.full_name" class="block truncate text-[10px] text-muted-foreground">{{ r.email }}</span>
        </button>
      </li>
    </ul>
    <p v-if="showStatusLine" class="mt-1 text-[10px]" :class="[picked ? 'text-success' : 'text-muted-foreground']">
      <span v-if="searching">Searching…</span>
      <span v-else-if="picked">✓ {{ picked.full_name || picked.email }}</span>
      <span v-else>No matches.</span>
    </p>
  </div>
</template>
