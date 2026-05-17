import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseServiceRole } from '#supabase/server/serverSupabaseServiceRole'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from './logger'

// Server-side RBAC. Mirrors the SQL `current_user_role()` helper but reads
// the same column directly so server code can branch on role without an
// extra round-trip through PostgREST.
//
// IMPORTANT: this is a UX/UI helper. The source of truth for what a user
// can actually read/write is the RLS policy on the target table â€” the
// client cannot bypass that, even if this returns the wrong role somehow.

export type Role = 'admin' | 'manager' | 'agent'

export type ProfileSummary = {
  id: string
  role: Role
  team_id: string | null
  full_name: string | null
  email: string | null
  avatar_url: string | null
}

const ROLE_RANK: Record<Role, number> = { admin: 3, manager: 2, agent: 1 }

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'manager' || value === 'agent'
}

/**
 * Returns the role of the authenticated user. Defaults to 'agent' when
 * no profile row exists or the role is malformed â€” never throws, never
 * grants elevated privileges by accident.
 */
export async function getUserRole(event: H3Event): Promise<Role> {
  const profile = await getUserProfile(event)
  return profile?.role ?? 'agent'
}

/** Fetches the calling user's profile summary in one round trip.
 *
 *  Reads via the service-role client. We already validated the caller's
 *  auth via serverSupabaseUser; the only data we expose is the caller's
 *  own profile row. Going through the user-scoped client here used to
 *  silently fall back to role='agent' whenever the profiles RLS policy
 *  blocked the SELECT (we couldn't tell apart "no row" from "RLS blocked
 *  it"), which was the root cause of admin users seeing the agent UI. */
export async function getUserProfile(event: H3Event): Promise<ProfileSummary | null> {
  const user = await serverSupabaseUser(event)
  if (!user) return null

  // Service-role read so RLS never silently downgrades the role. If this
  // throws (no service key configured), fall back to the user-scoped read
  // so dev environments without the service key still work.
  let row: any = null
  try {
    const sr = serverSupabaseServiceRole(event) as any
    const { data, error } = await sr
      .from('profiles')
      .select('id, role, team_id, full_name, email, avatar_url')
      .eq('id', user.id)
      .maybeSingle()
    if (error) {
      logger.warn(
        { err: error.message, code: (error as any).code, op: 'rbac.profile.service_role' },
        'profile_read_failed_service_role',
      )
    } else {
      row = data
    }
  } catch (err: any) {
    // Service key missing or other env issue — try the user-scoped path.
    logger.warn({ err: err?.message, op: 'rbac.profile.service_role_throw' }, 'profile_read_service_role_threw')
    const client = await serverSupabaseClient(event)
    const { data } = await (client as any)
      .from('profiles')
      .select('id, role, team_id, full_name, email, avatar_url')
      .eq('id', user.id)
      .maybeSingle()
    row = data
  }

  if (!row) {
    logger.warn(
      { userId: user.id, op: 'rbac.profile.missing' },
      'profile_row_missing_for_user',
    )
    return {
      id: user.id,
      role: 'agent',
      team_id: null,
      full_name: null,
      email: user.email ?? null,
      avatar_url: null,
    }
  }

  return {
    id: row.id,
    role: isRole(row.role) ? row.role : 'agent',
    team_id: row.team_id ?? null,
    full_name: row.full_name ?? null,
    email: row.email ?? null,
    avatar_url: row.avatar_url ?? null,
  }
}

/** True when the caller's role is at or above `minimum`. */
export async function hasRole(event: H3Event, minimum: Role): Promise<boolean> {
  const role = await getUserRole(event)
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/**
 * Throws 403 unless the caller has at least `minimum`. Use at the top of
 * write endpoints that should be hard-gated regardless of RLS â€” for
 * example, an admin-only seed/import route.
 */
export async function requireRole(event: H3Event, minimum: Role): Promise<void> {
  if (!(await hasRole(event, minimum))) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden: insufficient role',
    })
  }
}
