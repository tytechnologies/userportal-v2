import { computed, type ComputedRef } from 'vue'

// Provider-agnostic resolver for "what to show in the UI" given an
// authenticated user. Every provider stamps slightly different keys onto
// `user.user_metadata`:
//
//   email/password — usually only `full_name` (set at sign-up)
//   google         — `full_name`, `name`, `picture`, `avatar_url`, `email`
//   facebook       — `name`, `picture`, sometimes `full_name`, `email`
//
// Rather than scatter `user.user_metadata.full_name ?? user.user_metadata.name`
// fallbacks across components, callers depend on this composable. Keeps
// the per-provider key knowledge in one place — adding a third provider
// just means extending the fallback chain here.

export type DisplayUser = {
  id: string | null
  /** Best-effort human name. Always a non-empty string when a user is loaded. */
  name: string
  /** Lower-cased email if known. */
  email: string | null
  /** Avatar URL if any. Null when none of the providers gave us one. */
  avatar: string | null
  /** Single character for letter-avatar fallback. */
  initial: string
}

const EMPTY: DisplayUser = {
  id: null,
  name: 'Guest',
  email: null,
  avatar: null,
  initial: '?',
}

function pick(meta: Record<string, any> | null | undefined, ...keys: string[]): string | null {
  if (!meta) return null
  for (const k of keys) {
    const v = meta[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/**
 * Reactive view of the current Supabase user normalized for display.
 * Returns a stable EMPTY object when no user is signed in, so templates
 * can render `{{ display.name }}` unconditionally.
 */
export function useDisplayUser(): ComputedRef<DisplayUser> {
  const user = useSupabaseUser()
  return computed<DisplayUser>(() => {
    const u = user.value
    if (!u) return EMPTY

    const meta = (u.user_metadata ?? null) as Record<string, any> | null
    const email = (u.email ?? pick(meta, 'email'))?.toLowerCase() ?? null

    // full_name → name → email local-part → 'User'. Same fallback the
    // public.handle_new_user() trigger uses, so the UI matches profiles.
    const name =
      pick(meta, 'full_name', 'name') ??
      (email ? email.split('@')[0] : null) ??
      'User'

    const avatar = pick(meta, 'avatar_url', 'picture')

    return {
      id: u.id,
      name,
      email,
      avatar,
      initial: name.charAt(0).toUpperCase(),
    }
  })
}
