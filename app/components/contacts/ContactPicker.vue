<script setup lang="ts">
// Search-as-you-type contact picker. Goes through useContacts.fetchContacts,
// which is RLS-gated — agents only see their own contacts; managers /
// admins see broader scope per Phase-4 policy.
//
// Emits a `select` event with the full contact row when the user picks
// one, plus a `clear` event when they remove the selection. Parents that
// need just the id can read `selected?.id`; parents that want to auto-
// fill name/email/phone fields use the full row.
//
// Usage:
//   <ContactPicker
//     label="Owner"
//     :selected="form.ownerData.selectedContact"
//     @select="(c) => onContactPick(c)"
//     @clear="onContactClear"
//   />

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useContacts, type Contact } from '~/composables/useContacts'

const props = defineProps<{
  label?: string
  /** Currently selected contact (controlled). Optional — uncontrolled also works. */
  selected?: Contact | null
  /** Hint text in the input. */
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'select', contact: Contact): void
  (e: 'clear'): void
}>()

const { fetchContacts } = useContacts()

const search = ref('')
const results = ref<Contact[]>([])
const isOpen = ref(false)
const isLoading = ref(false)
const inflightSearch = ref<string>('')

// Refs + computed style for the teleported dropdown. We render the
// dropdown into <body> via <Teleport> so it escapes any overflow:hidden
// / overflow-auto ancestors (the document forms render the picker
// inside a scrollable modal section, which previously clipped the
// dropdown — making it look like clicks did nothing).
const inputEl = ref<HTMLInputElement | null>(null)
const dropdownStyle = ref<Record<string, string>>({})

function recomputeDropdownPosition() {
  if (!inputEl.value) return
  const r = inputEl.value.getBoundingClientRect()
  dropdownStyle.value = {
    position: 'fixed',
    top: `${r.bottom + 4}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    zIndex: '9999',
  }
}

// Reposition while open in case the user scrolls the modal body or
// the window resizes — keeps the dropdown anchored to the input.
function onScrollOrResize() {
  if (isOpen.value) recomputeDropdownPosition()
}

onMounted(() => {
  window.addEventListener('scroll', onScrollOrResize, true) // capture: catches scroll on any ancestor
  window.addEventListener('resize', onScrollOrResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
})

// 250ms debounce so typing doesn't fire a request per keystroke. The
// inflight tracker lets us discard out-of-order responses.
let timer: ReturnType<typeof setTimeout> | null = null

watch(search, (q) => {
  if (timer) clearTimeout(timer)
  if (!q.trim()) {
    results.value = []
    isOpen.value = false
    return
  }
  timer = setTimeout(() => runSearch(q), 250)
})

async function runSearch(q: string) {
  inflightSearch.value = q
  isLoading.value = true
  try {
    const rows = await fetchContacts({ search: q, limit: 20 })
    // Discard stale results — only keep the response matching the most
    // recent query (prevents a slow earlier request from clobbering a
    // newer one).
    if (inflightSearch.value !== q) return
    results.value = rows
    isOpen.value = true
    // Position the teleported dropdown after the open flag flips so it
    // anchors to the current input rect.
    nextTick(recomputeDropdownPosition)
  } finally {
    if (inflightSearch.value === q) isLoading.value = false
  }
}

function pick(contact: Contact) {
  emit('select', contact)
  search.value = ''
  results.value = []
  isOpen.value = false
}

function clear() {
  emit('clear')
  search.value = ''
  results.value = []
  isOpen.value = false
}

function initial(c: Contact | null | undefined): string {
  return (c?.full_name || c?.email || '?').trim().charAt(0).toUpperCase() || '?'
}

// Close the dropdown when the user clicks somewhere else. Cheap event
// instead of a full v-click-outside dependency.
function onBlur(e: FocusEvent) {
  // Delay so a click on a result row registers before blur closes us.
  // Bumped from 120ms to 250ms because slow mousedown→mouseup on touch
  // pads / older devices was sometimes triggering blur-close before the
  // click event actually fired.
  setTimeout(() => {
    isOpen.value = false
  }, 250)
}

const subline = computed(() => (c: Contact) => {
  const bits: string[] = []
  if (c.email) bits.push(c.email)
  if (c.mobile_phone) bits.push(c.mobile_phone)
  return bits.join(' · ') || '—'
})
</script>

<template>
  <div class="relative">
    <label v-if="label" class="mb-1 block text-xs font-semibold text-foreground">
      {{ label }}
    </label>

    <!-- Selected state — show the picked contact + a clear button. -->
    <div
      v-if="selected"
      class="flex items-center gap-3 rounded-md border border-border bg-muted/50 px-3 py-2"
    >
      <div
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
        aria-hidden="true"
      >
        {{ initial(selected) }}
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-foreground">
          {{ selected.full_name || '(no name)' }}
        </p>
        <p class="truncate text-xs text-muted-foreground">{{ subline(selected) }}</p>
      </div>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted"
        @click="clear"
      >
        Change
      </button>
    </div>

    <!-- Search state — input + dropdown of matches. -->
    <div v-else>
      <input
        ref="inputEl"
        v-model="search"
        type="search"
        :placeholder="placeholder ?? 'Search contacts by name or email…'"
        class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
        @focus="isOpen = !!search.trim(); recomputeDropdownPosition()"
        @blur="onBlur"
      />

      <!-- Dropdown is teleported to <body> with computed fixed positioning
           so it escapes any overflow:hidden / overflow-auto ancestor
           (e.g. the document modals' scroll container which used to
           clip it and made clicks look broken). -->
      <Teleport to="body">
        <ul
          v-if="isOpen && (results.length > 0 || isLoading)"
          :style="dropdownStyle"
          class="max-h-72 overflow-y-auto rounded-md border border-border bg-background shadow-lg"
        >
          <li
            v-if="isLoading && results.length === 0"
            class="px-3 py-3 text-xs text-muted-foreground"
          >
            Searching…
          </li>
          <li
            v-for="c in results"
            :key="c.id"
            class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent hover:text-accent-foreground"
            role="button"
            tabindex="0"
            @mousedown.prevent
            @click="pick(c)"
            @keydown.enter="pick(c)"
          >
            <div
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
              aria-hidden="true"
            >
              {{ initial(c) }}
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-foreground">
                {{ c.full_name || '(no name)' }}
              </p>
              <p class="truncate text-xs text-muted-foreground">{{ subline(c) }}</p>
            </div>
          </li>
        </ul>

        <!-- Empty-results panel — also teleported so it isn't clipped. -->
        <div
          v-if="isOpen && !isLoading && search.trim() && results.length === 0"
          :style="dropdownStyle"
          class="rounded-md border border-border bg-background px-3 py-3 text-xs text-muted-foreground shadow-lg"
        >
          No matches. You can still fill in the fields below manually.
        </div>
      </Teleport>
    </div>
  </div>
</template>
