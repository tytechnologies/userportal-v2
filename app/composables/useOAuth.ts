// Single entry point for OAuth sign-in. Both providers route through the
// same Supabase call + the same /auth/callback page so adding a third
// provider later is one line in PROVIDERS plus a button in login.vue.
//
// Why a composable, not a per-button inline call: keeps redirectTo,
// scopes, and post-auth navigation in one place. The login page stays
// presentational; tests can mock this module without touching the page.

export type OAuthProvider = 'google' | 'facebook'

type LaunchOpts = {
  /** Where to land after the callback finishes. Defaults to /dashboard. */
  next?: string
}

// Per-provider config. `scopes` is space-separated per Supabase's API; we
// only ask for what we actually use (display name + avatar + email).
const PROVIDERS: Record<OAuthProvider, { scopes?: string }> = {
  google: { scopes: 'openid email profile' },
  facebook: { scopes: 'email public_profile' },
}

/**
 * Kicks off an OAuth redirect. Caller does NOT need to await navigation —
 * Supabase replaces window.location, so anything after this call is
 * effectively unreachable. We still return the {data,error} so the caller
 * can surface a toast if Supabase refuses to start the flow at all
 * (e.g. provider not enabled in the Supabase dashboard).
 *
 * Popup blockers: Supabase uses a same-tab redirect by default, so a
 * popup blocker is not in the path. The fallback is the same flow.
 */
export async function loginWithProvider(
  provider: OAuthProvider,
  opts: LaunchOpts = {},
) {
  const supabase = useSupabaseClient()
  const next = opts.next ?? '/dashboard'

  // window is unavailable during SSR; gate the redirect URL build behind
  // a typeof check so this composable is import-safe from anywhere.
  const origin =
    typeof window !== 'undefined' ? window.location.origin : ''
  const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent(next)}`

  return supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      scopes: PROVIDERS[provider].scopes,
    },
  })
}

/** Convenience wrappers — keep call sites readable. */
export const loginWithGoogle = (opts?: LaunchOpts) => loginWithProvider('google', opts)
export const loginWithFacebook = (opts?: LaunchOpts) => loginWithProvider('facebook', opts)
