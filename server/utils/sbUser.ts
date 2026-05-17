// Drop-in replacement for `#supabase/server/serverSupabaseUser` that
// preserves the legacy User shape (`{ id, email, ... }`) regardless of
// which @nuxtjs/supabase version is installed.
//
// As of @nuxtjs/supabase v2.x, the module's own `serverSupabaseUser`
// helper switched to `auth.getClaims()` which returns JWT claims:
//
//     v1.x:  { id: <uuid>, email, app_metadata, user_metadata, ... }
//     v2.x:  { sub: <uuid>, email, exp, role, ... }
//
// The codebase reads `user.id` in ~80 places (repositories, route
// handlers, audit-log helpers). Switching every reference to `user.sub`
// would be a sweeping change with high regression risk; routing the
// reads through this wrapper keeps a single source of truth.
//
// We call `auth.getUser()` directly on the Supabase client. supabase-js
// exposes that on every version we ship, and it returns the legacy User
// shape that the rest of the code already speaks.
//
// Returns `null` (never throws) on any auth failure so call sites can
// continue to use `if (!user) ...` without a try/catch.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export async function serverSupabaseUser(event: H3Event): Promise<any | null> {
  try {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).auth.getUser()
    if (error) return null
    return data?.user ?? null
  } catch {
    return null
  }
}
