<script setup lang="ts">
// Dropdown UI for the existing useSavedViews() composable. Save the
// current URL-synced filter snapshot under a name; load applies the
// saved URL via router.push; delete removes from localStorage.
//
// The composable is per-user, per-scope. Pass `scope="listings"` from
// the listings page so views don't leak into contacts/archives.
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useSavedViews, type SavedView } from '~/composables/useSavedViews'

const props = defineProps<{
  scope: string
}>()

const { views, activeView, save, load, remove, isCurrent } = useSavedViews(props.scope)

const open = ref(false)
const newName = ref('')
const containerEl = ref<HTMLElement | null>(null)

const sortedViews = computed(() =>
  [...views.value].sort((a, b) => b.createdAt - a.createdAt),
)

const handleSave = () => {
  const name = newName.value.trim()
  if (!name) return
  save(name)
  newName.value = ''
}

const handleLoad = (view: SavedView) => {
  load(view)
  open.value = false
}

// Click-outside close. Listener attached only while the dropdown is open
// to keep the global keydown surface minimal.
const onDocumentClick = (e: MouseEvent) => {
  if (!containerEl.value) return
  if (!containerEl.value.contains(e.target as Node)) open.value = false
}

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="containerEl" class="relative inline-block">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click.stop="open = !open"
    >
      <svg class="h-3.5 w-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 5v14l7-4 7 4V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2Z" />
      </svg>
      <span>{{ activeView?.name ?? 'Saved views' }}</span>
      <svg class="h-3 w-3 text-muted-foreground/70" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="m3 5 3 3 3-3" />
      </svg>
    </button>

    <Transition
      enter-active-class="transition-all duration-100 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition-all duration-75 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-border bg-background p-3 shadow-lg"
        role="menu"
      >
        <!-- Save the current view -->
        <form class="mb-3 flex items-center gap-2" @submit.prevent="handleSave">
          <input
            v-model="newName"
            type="text"
            placeholder="Save current filters as…"
            class="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
          />
          <button
            type="submit"
            :disabled="!newName.trim()"
            class="rounded-lg bg-blue px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </form>

        <!-- Saved list -->
        <div v-if="sortedViews.length === 0" class="px-2 py-4 text-center text-xs text-muted-foreground/70">
          No saved views yet.
        </div>
        <ul v-else class="max-h-72 overflow-y-auto">
          <li
            v-for="view in sortedViews"
            :key="view.id"
            class="group flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-accent hover:text-accent-foreground"
            :class="isCurrent(view) ? 'bg-primary/10' : ''"
          >
            <button
              type="button"
              class="flex-1 truncate text-left text-xs text-foreground"
              :class="isCurrent(view) ? 'font-semibold text-primary' : ''"
              :title="view.fullPath"
              @click="handleLoad(view)"
            >
              {{ view.name }}
            </button>
            <button
              type="button"
              class="text-xs text-muted-foreground/70 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              :title="`Delete ${view.name}`"
              @click.stop="remove(view.id)"
            >
              ✕
            </button>
          </li>
        </ul>
      </div>
    </Transition>
  </div>
</template>
