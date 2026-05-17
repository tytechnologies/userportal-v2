<script setup lang="ts">
// ⌘K / Ctrl+K palette. Mounted once in app.vue. Opens via the global
// hotkey installed by useCommandPalette().installGlobalHotkey(), or
// programmatically via `open()` from any caller.
//
// Default commands cover navigation + listings power-user actions. Any
// page can register more via the composable's `useScopedCommands(...)`.
//
// Keyboard:
//   ↑ / ↓     navigate items
//   Enter     run highlighted command
//   Escape    close
//   Ctrl/Cmd+K  toggle (handled at the global level)
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useCommandPalette, type Command } from '~/composables/useCommandPalette'

const router = useRouter()
const palette = useCommandPalette()

// Wrap router.push so its return type matches the Command.perform
// contract (`void | Promise<void>` — not `Promise<void | NavigationFailure>`).
// NavigationFailure is a normal Vue Router outcome (cancelled by a guard,
// duplicate route, etc.), not an error worth surfacing here.
function nav(to: Parameters<typeof router.push>[0]) {
  return () => {
    router.push(to).catch(() => {
      /* swallow NavigationFailure */
    })
  }
}

// Built-in commands. Registered once on mount so they survive page
// navigation. Page-scoped extras can be added by individual routes.
const seedCommands: Command[] = [
  {
    id: 'nav.listings',
    label: 'Go to Listings',
    hint: '/listings',
    kind: 'navigate',
    group: 'Navigation',
    keywords: ['listings', 'properties'],
    perform: nav('/listings'),
  },
  {
    id: 'nav.contacts',
    label: 'Go to Contacts',
    hint: '/contacts',
    kind: 'navigate',
    group: 'Navigation',
    keywords: ['contacts', 'people'],
    perform: nav('/contacts'),
  },
  {
    id: 'nav.dashboard',
    label: 'Go to Dashboard',
    hint: '/',
    kind: 'navigate',
    group: 'Navigation',
    keywords: ['dashboard', 'home'],
    perform: nav('/'),
  },
  {
    id: 'nav.deck',
    label: 'Go to Deck',
    hint: '/deck',
    kind: 'navigate',
    group: 'Navigation',
    keywords: ['deck', 'featured'],
    perform: nav('/deck'),
  },
  {
    id: 'action.search-by-id',
    label: 'Search listing by ID',
    hint: 'Listings · ?searchColumn=listing_id',
    kind: 'action',
    group: 'Actions',
    keywords: ['search', 'find', 'id', 'listing'],
    perform: nav({
      path: '/listings',
      query: { searchColumn: 'listing_id' },
    }),
  },
  {
    id: 'action.clear-filters',
    label: 'Clear listing filters',
    hint: 'Listings',
    kind: 'action',
    group: 'Actions',
    keywords: ['reset', 'clear'],
    // Land on /listings with no query string. The page reads filters
    // from the URL on mount, so this is equivalent to a manual reset.
    perform: nav({ path: '/listings', query: {} }),
  },
]

// Defer registration + hotkey install to mount. Setup must stay
// declarative — synchronous side-effects on module-level reactive state
// during setup have been observed to interact badly with Vite's
// production minifier (TDZ on closed-over registry refs).
onMounted(() => {
  palette.register(...seedCommands)
  palette.installGlobalHotkey()
})

const query = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

// Recent commands — last-N invoked IDs, stored in localStorage so
// the list survives reloads / across-tab. When the palette opens
// with no query, the top group surfaces these for one-keystroke
// re-invocation. Limit kept small (5) to avoid the surface getting
// noisy and to make it obvious which entries are "recent" vs
// alphabetical groups.
const RECENT_KEY = 'hi:cmd-palette:recent'
const RECENT_LIMIT = 5
const recentIds = ref<string[]>([])

function loadRecent() {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      recentIds.value = parsed.filter((s) => typeof s === 'string').slice(0, RECENT_LIMIT)
    }
  } catch {
    /* corrupt entry — ignore, default to empty */
  }
}
loadRecent()

// Cross-tab sync — when another tab invokes a command, the storage
// event fires here. Re-read from localStorage so the Recent group
// in this tab stays in sync without a page reload. The storage event
// only fires in OTHER tabs (not the one that wrote), so there's no
// echo loop.
let onStorage: ((e: StorageEvent) => void) | null = null
onMounted(() => {
  if (typeof window === 'undefined') return
  onStorage = (e: StorageEvent) => {
    if (e.key === RECENT_KEY) loadRecent()
  }
  window.addEventListener('storage', onStorage)
})
onBeforeUnmount(() => {
  if (typeof window === 'undefined' || !onStorage) return
  window.removeEventListener('storage', onStorage)
  onStorage = null
})

function pushRecent(id: string) {
  // Move-to-front. Strip duplicates, cap at limit.
  const next = [id, ...recentIds.value.filter((x) => x !== id)].slice(0, RECENT_LIMIT)
  recentIds.value = next
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* quota / privacy mode — degrade silently */
  }
}

// "Recent" derived list — only shown when the query is empty AND
// the recent IDs still resolve to a known command (registry might
// have changed since last session).
const recentCommands = computed<Command[]>(() => {
  if (query.value.trim()) return []
  const byId = new Map(palette.commands.value.map((c) => [c.id, c]))
  return recentIds.value.map((id) => byId.get(id)).filter((c): c is Command => !!c)
})

// Filtered + grouped commands. Lightweight substring match — Phase 2 spec
// asked for "fuzzy", but a tokenized contains-all is plenty for ~30 actions
// and avoids pulling in a fuzzy lib for one feature.
const filtered = computed<Command[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return palette.commands.value
  const tokens = q.split(/\s+/)
  return palette.commands.value.filter((cmd) => {
    const haystack = [
      cmd.label,
      cmd.hint ?? '',
      cmd.searchText ?? '',
      ...(cmd.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase()
    return tokens.every((t) => haystack.includes(t))
  })
})

// Visual flat order — Recent items first (when query empty + matches
// resolve), then the rest of `filtered`. activeIndex indexes into
// THIS so arrow-key navigation lands on the same item the user sees
// highlighted. Recent commands also appear under their natural group
// below (intentional — both paths are discoverable).
const visualFlat = computed<Command[]>(() => {
  if (recentCommands.value.length === 0) return filtered.value
  return [...recentCommands.value, ...filtered.value]
})

// Group preserving discovery order so "Navigation" appears before
// "Actions" without an explicit sort.
const groupedFiltered = computed(() => {
  const groups = new Map<string, Command[]>()
  if (recentCommands.value.length > 0) {
    groups.set('Recent', recentCommands.value)
  }
  for (const cmd of filtered.value) {
    const key = cmd.group ?? 'Other'
    const arr = groups.get(key) ?? []
    arr.push(cmd)
    groups.set(key, arr)
  }
  return Array.from(groups.entries())
})

// Highlighted index — kept in sync with the flat VISUAL order
// (Recent + filtered) so arrow-key nav lands on the same row the
// user sees highlighted. Reset on filtered/recent changes.
const activeIndex = ref(0)

watch(visualFlat, () => {
  activeIndex.value = 0
})

watch(
  () => palette.isOpen.value,
  (open) => {
    if (open) {
      query.value = ''
      activeIndex.value = 0
      // Focus the input on the next tick so the modal has rendered.
      nextTick(() => inputEl.value?.focus())
    }
  },
)

const move = (delta: number) => {
  if (visualFlat.value.length === 0) return
  const next = activeIndex.value + delta
  // Wrap so arrow-up from index 0 goes to the last entry.
  const len = visualFlat.value.length
  activeIndex.value = ((next % len) + len) % len
}

const runActive = async () => {
  const cmd = visualFlat.value[activeIndex.value]
  if (!cmd) return
  // Close before running so the route push / async work isn't racing
  // a focus restore on an unmounted input.
  palette.close()
  // Track for "Recent" — fire BEFORE perform so the entry is recorded
  // even if perform throws (a failure is still a meaningful "I tried
  // X" signal that the user might want to retry).
  pushRecent(cmd.id)
  try {
    await cmd.perform()
  } catch (err) {
    console.error(`[CommandPalette] command "${cmd.id}" threw:`, err)
  }
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runActive()
  }
  // Escape is handled globally by useCommandPalette().
}

// Highlight follows arrow keys via visualFlat indexing. We compare
// by id since the same command can appear twice in the rendered list
// (once under Recent, once under its natural group) — but only the
// FIRST visual occurrence (i.e. Recent when active) wins the
// highlight, matching what the user sees.
//
// The rendered template tracks `groupName` so we use a (groupName, id)
// composite to ensure the second occurrence doesn't also light up.
const activeId = computed(() => visualFlat.value[activeIndex.value]?.id ?? null)
const isActive = (groupName: string, cmd: Command) => {
  if (cmd.id !== activeId.value) return false
  // When the command is in Recent AND its native group, only the
  // Recent row should light up (it's earlier in visualFlat).
  if (recentCommands.value.length > 0 && recentCommands.value.some((r) => r.id === cmd.id)) {
    return groupName === 'Recent'
  }
  return true
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-100"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-75"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="palette.isOpen.value"
        class="fixed inset-0 z-[200] flex items-start justify-center bg-foreground/50 px-4 pt-[15vh]"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        @click.self="palette.close()"
      >
        <div
          class="w-full max-w-xl overflow-hidden rounded-lg border border-border-strong bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04),0_24px_48px_-12px_rgba(15,23,42,0.32)]"
        >
          <div class="flex items-center gap-3 border-b border-border px-4 py-3">
            <svg
              class="h-4 w-4 text-muted-foreground/70"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m21 21-4.3-4.3M10 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z"
              />
            </svg>
            <input
              ref="inputEl"
              v-model="query"
              type="text"
              placeholder="Search commands…"
              class="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
              @keydown="handleKeydown"
            />
            <kbd
              class="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70"
              >Esc</kbd
            >
          </div>

          <div class="max-h-[50vh] overflow-y-auto py-2">
            <div
              v-if="visualFlat.length === 0"
              class="px-4 py-8 text-center text-sm text-muted-foreground/70"
            >
              No matching commands
            </div>
            <template v-else>
              <div
                v-for="[groupName, items] in groupedFiltered"
                :key="groupName"
                class="mb-2"
              >
                <div
                  class="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
                >
                  {{ groupName }}
                </div>
                <button
                  v-for="cmd in items"
                  :key="`${groupName}-${cmd.id}`"
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors"
                  :class="
                    isActive(groupName, cmd)
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                  "
                  @mouseenter="activeIndex = visualFlat.findIndex((x) => x.id === cmd.id)"
                  @click="runActive()"
                >
                  <span class="font-medium">{{ cmd.label }}</span>
                  <span v-if="cmd.hint" class="text-xs text-muted-foreground/70">{{
                    cmd.hint
                  }}</span>
                </button>
              </div>
            </template>
          </div>

          <div
            class="flex items-center justify-end gap-3 border-t border-border bg-muted/50 px-4 py-2 text-[10px] text-muted-foreground/70"
          >
            <span class="flex items-center gap-1">
              <kbd class="rounded border border-border bg-background px-1.5">↑</kbd>
              <kbd class="rounded border border-border bg-background px-1.5">↓</kbd>
              navigate
            </span>
            <span class="flex items-center gap-1">
              <kbd class="rounded border border-border bg-background px-1.5">↵</kbd>
              run
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
