// Admin — list organizations with rollups.
//
// GET /api/admin/organizations
// Auth: admin (admin.access permission).
//
// Returns each org with branch_count + member_count rollups so the
// admin tab renders a useful overview without per-row drilldowns.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)

    const [orgsRes, branchCountsRes, memberCountsRes, ownersRes] = await Promise.all([
      (supabase as any)
        .from('organizations')
        .select('id, name, slug, verified, owner_user_id, description, deprecated_at:deprecated_at, created_at')
        .order('name'),
      // Branch and member counts per org via separate queries +
      // client-side grouping. PostgREST has no GROUP BY, but the
      // result sets are tiny (one row per org × pseudo-row) so it's
      // cheap.
      (supabase as any)
        .from('organization_branches')
        .select('organization_id, id'),
      (supabase as any)
        .from('organization_memberships')
        .select('organization_id, status'),
      (supabase as any)
        .from('organizations')
        .select('owner_user_id'),
    ])

    if (orgsRes.error) throw createError({ statusCode: 500, statusMessage: orgsRes.error.message })

    const branchCounts = new Map<string, number>()
    for (const b of branchCountsRes.data ?? []) {
      branchCounts.set(b.organization_id, (branchCounts.get(b.organization_id) ?? 0) + 1)
    }
    const memberCounts = new Map<string, number>()
    for (const m of memberCountsRes.data ?? []) {
      if (m.status !== 'active' && m.status !== 'trial') continue
      memberCounts.set(m.organization_id, (memberCounts.get(m.organization_id) ?? 0) + 1)
    }

    // Resolve owner profiles in one shot.
    const ownerIds = Array.from(new Set(
      (orgsRes.data ?? [])
        .map((o: any) => o.owner_user_id)
        .filter(Boolean),
    ))
    let ownerMap = new Map<string, any>()
    if (ownerIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, email')
        .in('id', ownerIds)
      for (const p of profiles ?? []) ownerMap.set(p.id, p)
    }

    const organizations = (orgsRes.data ?? []).map((o: any) => ({
      ...o,
      owner: o.owner_user_id ? (ownerMap.get(o.owner_user_id) ?? null) : null,
      branch_count: branchCounts.get(o.id) ?? 0,
      member_count: memberCounts.get(o.id) ?? 0,
    }))

    return { organizations }
  },
})
