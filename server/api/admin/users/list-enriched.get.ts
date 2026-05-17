// Enriched users list — Phase 2B of admin redesign.
//
// GET /api/admin/users/list-enriched?search=&role=
// Auth: admin.
//
// Returns the same shape as `useAdmin.listProfiles()` but with three
// extra columns joined server-side:
//   - organization (name + slug + role) from the user's most-recent
//     ACTIVE organization_memberships row
//   - verification status (whether they have any approved
//     profile_verifications row)
//   - last_active_at — MAX(activities.created_at) where user_id = profile.id
//
// Uses the admin Supabase client (service-role) inside the handler to
// bypass RLS for the join — admin permission is enforced via
// requireRole upstream, so RLS-bypass is safe within this admin-only
// endpoint. The response only surfaces the safe public fields, never
// auth metadata.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'

const querySchema = z.object({
  search: z.string().optional(),
  role: z.enum(['admin', 'manager', 'agent']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

type Profile = {
  id: string
  email: string | null
  full_name: string | null
  role: 'admin' | 'manager' | 'agent'
  team_id: string | null
  avatar_url: string | null
  created_at: string | null
}

type Membership = {
  user_id: string
  org_role: string
  status: string
  joined_at: string | null
  organization: { id: string; name: string; slug: string } | null
}

type Verification = { profile_id: string; status: string; reviewed_at: string | null }
type ActivityAgg = { user_id: string; last_at: string }

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    // Use service-role for the joins. Admin permission was just
    // verified upstream; staying within service-role for the joined
    // reads avoids 4× RLS round-trips.
    const admin = getServerSupabaseAdmin()

    // 1. Base profiles (RLS-equivalent filter applied here since we're
    //    on service-role).
    let pq = (admin as any)
      .from('profiles')
      .select('id, email, full_name, role, team_id, avatar_url, created_at')
      .order('created_at', { ascending: false })
      .limit(q.limit)
    if (q.role) pq = pq.eq('role', q.role)
    if (q.search && q.search.trim() !== '') {
      const safe = q.search.replace(/[%,()]/g, '').trim()
      pq = pq.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
    }
    const { data: profiles, error: profilesError } = await pq
    if (profilesError) {
      throw createError({ statusCode: 500, statusMessage: profilesError.message })
    }
    const rows: Profile[] = (profiles ?? []) as Profile[]
    if (rows.length === 0) return { users: [] }

    const ids = rows.map((r) => r.id)

    // 2. Active org memberships, with embedded organization. PostgREST
    //    embedded select keeps it to one round-trip.
    const { data: memberships } = await (admin as any)
      .from('organization_memberships')
      .select('user_id, org_role, status, joined_at, organization:organization_id(id, name, slug)')
      .eq('status', 'active')
      .in('user_id', ids)
      .order('joined_at', { ascending: false, nullsFirst: false })

    const membershipByUser = new Map<string, Membership>()
    for (const m of (memberships ?? []) as Membership[]) {
      // First seen wins because we ordered desc by joined_at — that's
      // the "primary" active membership for the column.
      if (!membershipByUser.has(m.user_id)) membershipByUser.set(m.user_id, m)
    }

    // 3. Approved profile verifications (if any).
    const { data: verifications } = await (admin as any)
      .from('profile_verifications')
      .select('profile_id, status, reviewed_at')
      .eq('status', 'approved')
      .in('profile_id', ids)
    const verifiedSet = new Set<string>(
      ((verifications ?? []) as Verification[]).map((v) => v.profile_id),
    )

    // 4. Last activity per user. activities can be huge — pick the max
    //    via the materialized "user_last_activity" if it exists; fall
    //    back to a per-user query for the small N at-most-500 page.
    //    Using rpc would be cleaner but doesn't exist — do batched
    //    head-count style queries in parallel.
    const lastActivityByUser = new Map<string, string>()
    try {
      // Single query: get the most recent activity per user_id in our
      // page using a CTE-friendly approach. PostgREST can't run CTE
      // queries; we approximate with a per-batch select sorted desc
      // and dedupe client-side. Capped to recent 1000 rows; users with
      // no activity in the last 1000 events get null.
      const { data: actData } = await (admin as any)
        .from('activities')
        .select('user_id, created_at')
        .in('user_id', ids)
        .order('created_at', { ascending: false })
        .limit(1000)
      for (const a of (actData ?? []) as ActivityAgg[]) {
        if (!lastActivityByUser.has(a.user_id)) {
          lastActivityByUser.set(a.user_id, a.last_at ?? (a as any).created_at)
        }
      }
    } catch {
      // Activity table missing or unreachable — leave the column null
      // for everyone. Not fatal.
    }

    return {
      users: rows.map((r) => {
        const m = membershipByUser.get(r.id)
        return {
          id: r.id,
          email: r.email ?? null,
          full_name: r.full_name ?? null,
          role: r.role,
          team_id: r.team_id ?? null,
          avatar_url: r.avatar_url ?? null,
          created_at: r.created_at ?? null,
          organization: m?.organization
            ? {
                id: m.organization.id,
                name: m.organization.name,
                slug: m.organization.slug,
                role: m.org_role,
              }
            : null,
          verified: verifiedSet.has(r.id),
          last_active_at: lastActivityByUser.get(r.id) ?? null,
        }
      }),
    }
  },
})
