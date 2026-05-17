// Shared current-user profile row. Multiple components (Navbar,
// my-profile, NewForm, DashboardFooter…) each used to fire their own
// `from('profiles').select('*').eq('email', user.email).single()`
// query on mount — verified 4 identical Supabase round trips per page
// load in the 2026-05-14 smoke test.
//
// Fix: a single useState-backed cache keyed by the signed-in user's
// id. First caller fires the round trip; subsequent callers consume
// the cached row. Reactive — when the auth user changes (sign-out /
// switch), the cache resets and the next caller re-fetches.

import { computed, watch, type ComputedRef, type Ref } from 'vue'

export type ProfileRow = {
  id: string
  email: string | null
  full_name: string | null
  display_name: string | null
  designation: string | null
  contact: string | null
  link: string | null
  notes: string | null
  avatar_url: string | null
  role: string | null
  team_id: string | null
  // Catch-all so the existing callers that read uncommon columns
  // (e.g. AddListingWizard's branch on user_metadata) keep working.
  [key: string]: unknown
}

export type CurrentProfileState = {
  profile: Ref<ProfileRow | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  /** Force a re-fetch (e.g. after the user updates their profile). */
  refresh: () => Promise<void>
  /** True when the profile is loaded AND non-null. */
  ready: ComputedRef<boolean>
}

let fetchInFlight: Promise<void> | null = null

export function useCurrentProfile(): CurrentProfileState {
  // useState keys cache by user id; clears on sign-out via the watcher.
  const profile = useState<ProfileRow | null>('current-profile', () => null)
  const loading = useState<boolean>('current-profile:loading', () => false)
  const error = useState<string | null>('current-profile:error', () => null)
  const cachedForId = useState<string | null>('current-profile:cached-for', () => null)

  const user = useSupabaseUser()

  async function fetchProfile(): Promise<void> {
    const u = user.value
    if (!u?.email) {
      profile.value = null
      cachedForId.value = null
      return
    }
    if (cachedForId.value === u.id && profile.value) {
      // Already loaded for this user.
      return
    }
    // De-dupe simultaneous calls from multiple components mounting at once.
    if (fetchInFlight) return fetchInFlight

    loading.value = true
    error.value = null
    fetchInFlight = (async () => {
      try {
        const supabase = useSupabaseClient()
        const { data, error: err } = await (supabase as any)
          .from('profiles')
          .select('*')
          .eq('email', u.email)
          .maybeSingle()
        if (err) {
          error.value = err.message ?? 'profile_lookup_failed'
          return
        }
        profile.value = (data as ProfileRow) ?? null
        cachedForId.value = u.id
      } catch (err: any) {
        error.value = err?.message ?? 'profile_lookup_threw'
      } finally {
        loading.value = false
        fetchInFlight = null
      }
    })()
    return fetchInFlight
  }

  async function refresh(): Promise<void> {
    cachedForId.value = null
    profile.value = null
    await fetchProfile()
  }

  // Auto-clear when the signed-in user changes.
  watch(user, (u, prev) => {
    if (u?.id !== prev?.id) {
      profile.value = null
      cachedForId.value = null
    }
    if (u?.email) {
      // Don't await — caller can `await fetchProfile()` if they need
      // the value synchronously. `.catch()` per the no-void-promises rule.
      fetchProfile().catch(() => undefined)
    }
  }, { immediate: true })

  const ready = computed(() => !loading.value && profile.value != null)

  return { profile, loading, error, refresh, ready }
}
