// "My organizations" â€” orgs the caller is a member of.
//
// GET /api/organizations
// Auth: required. RLS gates to active memberships only.
//
// Response is a flat list with the user's org_role inlined so the
// page can pick which org to default to (typically the first
// brokerage_owner / branch_manager membership; falls back to
// senior_agent / junior_agent).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'

const ROLE_PRIORITY: Record<string, number> = {
  brokerage_owner: 1,
  branch_manager:  2,
  team_lead:       3,
  senior_agent:    4,
  junior_agent:    5,
  assistant:       6,
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (supabase as any)
      .from('organization_memberships')
      .select(`
        id, org_role, status, branch_id, team_id, joined_at,
        organization:organizations!organization_memberships_organization_id_fkey (
          id, name, slug, branding, verified, owner_user_id, description
        )
      `)
      .eq('user_id', user.id)
      .in('status', ['active', 'trial'])

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    // Sort by role priority so the page can default to the highest-
    // privilege membership first. brokerage_owner > branch_manager > ...
    const memberships = (data ?? []).slice().sort((a: any, b: any) => {
      return (ROLE_PRIORITY[a.org_role] ?? 99) - (ROLE_PRIORITY[b.org_role] ?? 99)
    })

    return { memberships }
  },
})
