import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export type SavedView = {
  id: string
  name: string
  /** route.fullPath snapshot: pathname + URL-synced filter query */
  fullPath: string
  createdAt: number
}

const STORAGE_KEY_PREFIX = 'hi:savedViews'

const storageKey = (userId: string | undefined, scope: string) =>
  `${STORAGE_KEY_PREFIX}:${userId ?? 'anon'}:${scope}`

const readStorage = (key: string): SavedView[] => {
  if (import.meta.server) return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeStorage = (key: string, views: SavedView[]) => {
  if (import.meta.server) return
  try {
    localStorage.setItem(key, JSON.stringify(views))
  } catch {
    // quota exceeded or storage disabled — silently drop
  }
}

/**
 * Per-user, per-page saved views backed by localStorage. Each view captures
 * the current `route.fullPath` so loading it restores all URL-synced state
 * (filters, search, etc.).
 *
 * Usage:
 *   const { views, save, load, remove, isCurrent } = useSavedViews('listings')
 *   save('Available 3BR Makati')
 */
export const useSavedViews = (scope: string) => {
  const route = useRoute()
  const router = useRouter()
  const user = useSupabaseUser()

  const views = ref<SavedView[]>(readStorage(storageKey(user.value?.id, scope)))

  // If the user logs in/out, swap to the new bucket of views.
  watch(
    () => user.value?.id,
    (uid) => { views.value = readStorage(storageKey(uid, scope)) },
  )

  const persist = () => writeStorage(storageKey(user.value?.id, scope), views.value)

  const save = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    views.value = [
      ...views.value,
      {
        id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: trimmed,
        fullPath: route.fullPath,
        createdAt: Date.now(),
      },
    ]
    persist()
  }

  const load = (view: SavedView) => router.push(view.fullPath)

  const remove = (id: string) => {
    views.value = views.value.filter((v) => v.id !== id)
    persist()
  }

  const rename = (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    views.value = views.value.map((v) => (v.id === id ? { ...v, name: trimmed } : v))
    persist()
  }

  /** True when the current route matches the saved view's path + query exactly. */
  const isCurrent = (view: SavedView) => view.fullPath === route.fullPath

  const activeView = computed(() => views.value.find(isCurrent))

  return { views, activeView, save, load, remove, rename, isCurrent }
}
