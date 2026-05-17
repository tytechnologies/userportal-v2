// Onboarding progress for the dashboard checklist widget.
//
// GET /api/dashboard/onboarding-progress
// Auth: required.
//
// Returns a small status payload with the milestones the day-1
// owner needs to clear:
//   1. has_org           â€” created or joined a brokerage
//   2. team_size         â€” # of OTHER active members of the primary org
//   3. listings_count    â€” # of listings created by any active member
//                          of the primary org (org-wide, not RLS-scoped)
//   4. is_complete       â€” true once all three are non-zero
//
// Uses service role for the listings count so an owner who isn't the
// listing's creator still sees their org's activity (RLS would scope
// to team_id which understates org-wide totals). The data exposed is
// just counts, no rows.

import { serverSupabaseUser } from '../../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'

const ROLE_PRIORITY: Record<string, number> = {
  brokerage_owner: 1,
  branch_manager:  2,
  team_lead:       3,
  broker:          4,
  senior_agent:    4,
  coordinator:     5,
  junior_agent:    6,
  assistant:       7,
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')

    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const admin = getServerSupabaseAdmin()

    // Active memberships for this user
    const { data: memberships, error: memErr } = await (admin as any)
      .from('organization_memberships')
      .select('organization_id, org_role, status')
      .eq('user_id', user.id)
      .in('status', ['active', 'trial'])
    if (memErr) {
      throw createError({ statusCode: 500, statusMessage: memErr.message })
    }

    const has_org = (memberships?.length ?? 0) > 0

    if (!has_org) {
      return {
        has_org: false,
        team_size: 0,
        listings_count: 0,
        primary_org_id: null,
        primary_org_role: null,
        is_complete: false,
      }
    }

    // Pick primary org by role priority. Same logic as /api/organizations
    // GET so the rest of the UI agrees on which org is "current".
    const sorted = (memberships ?? []).slice().sort((a: any, b: any) =>
      (ROLE_PRIORITY[a.org_role] ?? 99) - (ROLE_PRIORITY[b.org_role] ?? 99),
    )
    const primary = sorted[0]!
    const primary_org_id = primary.organization_id as string

    // Team size = active members in the primary org, excluding self
    const { count: memberCount, error: teamErr } = await (admin as any)
      .from('organization_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', primary_org_id)
      .in('status', ['active', 'trial'])
      .neq('user_id', user.id)
    if (teamErr) {
      throw createError({ statusCode: 500, statusMessage: teamErr.message })
    }

    // Active member ids (including self) for listing-creator filter
    const { data: orgMembers } = await (admin as any)
      .from('organization_memberships')
      .select('user_id')
      .eq('organization_id', primary_org_id)
      .in('status', ['active', 'trial'])
    const memberIds = (orgMembers ?? []).map((m: any) => m.user_id).filter(Boolean)

    // Listings â€” saved guidance forbids `count: 'exact'` on listings (full
    // scan timeout). Planned counts can be stale right after the first
    // INSERT, which would leave the checklist showing "add a listing"
    // even after they added one â€” confusing UX. We just need "â‰¥ 1," so
    // probe with LIMIT 1 instead. Cheap and instantly accurate.
    let has_listing = false
    if (memberIds.length > 0) {
      const { data: probe, error: listErr } = await (admin as any)
        .from('listings')
        .select('id')
        .in('created_by', memberIds)
        .limit(1)
      if (!listErr) has_listing = (probe?.length ?? 0) > 0
    }
    const listings_count = has_listing ? 1 : 0

    const team_size = Number(memberCount ?? 0)
    const is_complete = has_org && team_size >= 1 && listings_count >= 1

    return {
      has_org,
      team_size,
      listings_count,
      primary_org_id,
      primary_org_role: primary.org_role as string,
      is_complete,
    }
  },
})
