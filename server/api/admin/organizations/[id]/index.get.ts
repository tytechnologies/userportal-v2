// Admin — full organization detail.
//
// GET /api/admin/organizations/:id
// Auth: admin.
//
// Returns the org + branches + members (with profile rows) so the
// admin tab's drilldown panel renders in one round trip.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const orgId = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }

    const supabase = await serverSupabaseClient(event)

    const [orgRes, branchesRes, membersRes] = await Promise.all([
      (supabase as any)
        .from('organizations')
        .select('id, name, slug, branding, verified, owner_user_id, description, created_at, updated_at')
        .eq('id', orgId)
        .maybeSingle(),
      (supabase as any)
        .from('organization_branches')
        .select('id, name, slug, address, manager_user_id, active, created_at')
        .eq('organization_id', orgId)
        .order('name'),
      (supabase as any)
        .from('organization_memberships')
        .select('id, user_id, org_role, status, branch_id, team_id, invited_at, joined_at, created_at')
        .eq('organization_id', orgId)
        .order('created_at'),
    ])

    if (orgRes.error) throw createError({ statusCode: 500, statusMessage: orgRes.error.message })
    if (!orgRes.data)  throw createError({ statusCode: 404, statusMessage: 'Organization not found' })

    // Resolve user profiles (owners, branch managers, members) in one query.
    const userIds = new Set<string>()
    if (orgRes.data.owner_user_id) userIds.add(orgRes.data.owner_user_id)
    for (const b of branchesRes.data ?? []) {
      if (b.manager_user_id) userIds.add(b.manager_user_id)
    }
    for (const m of membersRes.data ?? []) {
      if (m.user_id) userIds.add(m.user_id)
    }

    let profileMap = new Map<string, any>()
    if (userIds.size > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', Array.from(userIds))
      for (const p of profiles ?? []) profileMap.set(p.id, p)
    }

    return {
      organization: {
        ...orgRes.data,
        owner: orgRes.data.owner_user_id ? (profileMap.get(orgRes.data.owner_user_id) ?? null) : null,
      },
      branches: (branchesRes.data ?? []).map((b: any) => ({
        ...b,
        manager: b.manager_user_id ? (profileMap.get(b.manager_user_id) ?? null) : null,
      })),
      members: (membersRes.data ?? []).map((m: any) => ({
        ...m,
        profile: m.user_id ? (profileMap.get(m.user_id) ?? null) : null,
      })),
    }
  },
})
