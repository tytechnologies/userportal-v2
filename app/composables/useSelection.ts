import { computed, ref, type ComputedRef, type Ref } from 'vue'

// Generic Set-backed selection state. Reactive on .add / .delete via a
// monotonically incrementing version ref (Vue 3.5+ tracks Sets directly,
// but we keep this pattern explicit so consumers can rely on it across
// minor version bumps).
//
// Usage:
//   const sel = useSelection<number>()
//   sel.toggle(42)
//   sel.has(42) // true
//   sel.size.value // 1
//   sel.clear()
//
// Pass an `equals` if your IDs aren't primitives (rare in this codebase).

export interface Selection<T> {
  ids: Ref<Set<T>>
  size: ComputedRef<number>
  isEmpty: ComputedRef<boolean>
  has: (id: T) => boolean
  add: (id: T) => void
  remove: (id: T) => void
  toggle: (id: T) => void
  clear: () => void
  // Replace the entire selection. Useful for select-all / select-none over
  // a known set of IDs.
  setAll: (ids: Iterable<T>) => void
  // Toggle "all of these" — if every id is already selected, clear them;
  // otherwise add the missing ones. Drives select-all checkbox UX.
  toggleAll: (ids: T[]) => void
  // Snapshot as a plain array (for API calls).
  asArray: () => T[]
}

export function useSelection<T = number>(): Selection<T> {
  const ids = ref<Set<T>>(new Set()) as Ref<Set<T>>

  const size = computed(() => ids.value.size)
  const isEmpty = computed(() => ids.value.size === 0)

  const has = (id: T) => ids.value.has(id)

  const add = (id: T) => {
    if (!ids.value.has(id)) {
      // Re-assign so Vue's reactivity picks up the change. Mutating the
      // Set in place works in Vue 3.5+ but the explicit reassign is robust
      // across versions and free of edge cases with proxied iterators.
      const next = new Set(ids.value)
      next.add(id)
      ids.value = next
    }
  }

  const remove = (id: T) => {
    if (ids.value.has(id)) {
      const next = new Set(ids.value)
      next.delete(id)
      ids.value = next
    }
  }

  const toggle = (id: T) => {
    ids.value.has(id) ? remove(id) : add(id)
  }

  const clear = () => {
    if (ids.value.size > 0) ids.value = new Set()
  }

  const setAll = (newIds: Iterable<T>) => {
    ids.value = new Set(newIds)
  }

  const toggleAll = (rowIds: T[]) => {
    const allSelected = rowIds.length > 0 && rowIds.every((id) => ids.value.has(id))
    if (allSelected) {
      // Subtract — remove these ids from the existing selection (so other
      // pages' selections persist, if the consumer is using cross-page mode).
      const next = new Set(ids.value)
      for (const id of rowIds) next.delete(id)
      ids.value = next
    } else {
      const next = new Set(ids.value)
      for (const id of rowIds) next.add(id)
      ids.value = next
    }
  }

  const asArray = () => Array.from(ids.value)

  return {
    ids,
    size,
    isEmpty,
    has,
    add,
    remove,
    toggle,
    clear,
    setAll,
    toggleAll,
    asArray,
  }
}
