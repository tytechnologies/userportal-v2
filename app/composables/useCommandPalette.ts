import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue'

// Command palette state + global hotkey. Mounted once via <CommandPalette>
// in app.vue; any caller can `useCommandPalette()` to read state, register
// extra commands, or open/close the palette imperatively.
//
// Hotkey: ⌘K (Mac) / Ctrl+K (Windows / Linux). Bound globally in the
// <CommandPalette> component's onMounted via this composable's
// `installGlobalHotkey()` so the palette doesn't need to live in every page.

export type CommandKind = 'navigate' | 'action'

export type CommandRole = 'admin' | 'manager' | 'agent'

export interface Command {
  // Stable identifier. Used as the v-for key.
  id: string
  // Visible label.
  label: string
  // Optional secondary line (path, hint, shortcut hint).
  hint?: string
  kind: CommandKind
  // Categorization for grouping in the UI.
  group?: string
  // Lower-case haystack derived once; consumers can pre-compute or rely on
  // the default which concatenates label + hint.
  searchText?: string
  // Keywords searched alongside label. Lets "list" match the "Go to
  // Listings" command without bloating the label.
  keywords?: string[]
  // Imperative action. Receives no arguments — the palette closes itself
  // before invoking, so navigation actions can navigate without racing the
  // palette's escape handler.
  perform: () => void | Promise<void>
  // Optional role gate. When set, the command is only visible to users
  // whose role rank is at least the named tier (admin > manager > agent).
  // Centralizing this here means each registration site doesn't have to
  // re-implement the gate (and can't accidentally expose admin commands
  // to agents). Omit for commands every authenticated user can run.
  requiresRole?: CommandRole
}

const isOpen = ref(false)
// Module-level registry — every page that mounts can append commands;
// the palette UI reads `commands` reactively. Commands registered from a
// page should be cleaned up in onBeforeUnmount() if they only make sense
// on that page.
//
// Named with the underscore prefix to avoid shadowing the `commands`
// property exposed on the composable's return object — production
// minifiers have been observed to mishandle that closure in some Vite
// builds, producing "Cannot access X before initialization" TDZ errors.
const _commandRegistry = ref<Command[]>([])

const open = () => {
  isOpen.value = true
}

const close = () => {
  isOpen.value = false
}

const toggle = () => {
  isOpen.value = !isOpen.value
}

const register = (...next: Command[]) => {
  _commandRegistry.value = [..._commandRegistry.value, ...next]
}

const unregister = (...ids: string[]) => {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  _commandRegistry.value = _commandRegistry.value.filter((c) => !idSet.has(c.id))
}

// Auto-cleanup wrapper for use inside setup() blocks. Returns the
// unregister fn so callers can also trigger cleanup manually.
const useScopedCommands = (toRegister: Command[]) => {
  register(...toRegister)
  const cmdIds = toRegister.map((c) => c.id)
  onBeforeUnmount(() => unregister(...cmdIds))
  return () => unregister(...cmdIds)
}

// Single global hotkey listener — installed by <CommandPalette> on mount,
// removed on unmount. Subsequent installs are no-ops.
let hotkeyInstalled = false
const installGlobalHotkey = () => {
  if (hotkeyInstalled || typeof window === 'undefined') return
  hotkeyInstalled = true

  const handler = (e: KeyboardEvent) => {
    // Cmd+K / Ctrl+K opens the palette. Also closes on second press.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      toggle()
      return
    }
    // Escape closes when open. Captured here so individual modals don't
    // need their own listeners; they can also handle escape themselves.
    if (e.key === 'Escape' && isOpen.value) {
      e.preventDefault()
      close()
    }
  }

  window.addEventListener('keydown', handler)
  // Best effort cleanup if the singleton is ever reset (HMR, tests).
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('keydown', handler)
      hotkeyInstalled = false
    })
  }
}

// Role rank — duplicated from useAuth to avoid a circular import (the
// auth composable's surface is large; we only need the rank table).
// Keep in sync if the auth tiers ever change.
const COMMAND_ROLE_RANK: Record<CommandRole, number> = {
  admin: 3,
  manager: 2,
  agent: 1,
}

// Active role for filtering commands. Plugins or layouts can call
// `setActiveRole('admin')` once the user profile resolves; until then
// the palette assumes the lowest tier (agent), which is the safest
// default — admin commands stay hidden until explicitly enabled.
const _activeRole = ref<CommandRole>('agent')

const setActiveRole = (role: CommandRole) => {
  _activeRole.value = role
}

// Filtered view over the registry. Hides any command whose
// `requiresRole` is higher than the current active tier. Centralizing
// this here means individual registration sites can't accidentally
// expose admin commands to agents — the contract is enforced at the
// edge that consumers read.
const commandsView = computed(() => {
  const activeRank = COMMAND_ROLE_RANK[_activeRole.value]
  return _commandRegistry.value.filter((cmd) => {
    if (!cmd.requiresRole) return true
    return COMMAND_ROLE_RANK[cmd.requiresRole] <= activeRank
  })
})

export function useCommandPalette() {
  return {
    isOpen,
    commands: commandsView,
    activeRole: _activeRole,
    open,
    close,
    toggle,
    register,
    unregister,
    useScopedCommands,
    installGlobalHotkey,
    setActiveRole,
  }
}
