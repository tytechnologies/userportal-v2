// Manager dashboard payload — pipeline + branches + brokers.
//
// GET /api/organizations/:id/dashboard
// Auth: required. RLS on the underlying views gates to org members
// (is_org_member helper from the brokerage migration).
//
// Single endpoint instead of three so the page paints atomically —
// one round trip, three views read in parallel server-side.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')

    const orgId = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }

    const supabase = await serverSupabaseClient(event)

    // Pipeline summary (per stage), branches (per office), brokers (per
    // agent). Each query is RLS-gated; if the caller isn't a member,
    // they'll get empty results — the org existence check below maps
    // that to 404 so we don't leak presence.
    const [orgRes, pipelineRes, branchesRes, brokersRes] = await Promise.all([
      (supabase as any)
        .from('organizations')
        .select('id, name, slug, branding, verified, owner_user_id, description')
        .eq('id', orgId)
        .maybeSingle(),
      (supabase as any)
        .from('organization_pipeline_summary')
        .select('stage_key, deal_count, won_count, lost_count, gmv_won')
        .eq('organization_id', orgId),
      (supabase as any)
        .from('branch_performance')
        .select('branch_id, branch_name, agent_count, active_deal_count, deals_closed_30d, gmv_30d')
        .eq('organization_id', orgId)
        .order('agent_count', { ascending: false }),
      // No PostgREST embed here — broker_performance is a view, and
      // PostgREST can't reliably infer a FK join into profiles from a
      // view. Resolve profiles in a parallel query below.
      (supabase as any)
        .from('broker_performance')
        .select(`
          user_id, branch_id, org_role,
          active_deal_count, deals_won_30d, gmv_90d,
          inquiries_received_30d, inquiries_responded_30d
        `)
        .eq('organization_id', orgId)
        .order('deals_won_30d', { ascending: false, nullsFirst: false })
        .limit(50),
    ])

    if (orgRes.error) {
      // PostgREST returns no error for empty results from .maybeSingle();
      // an actual error would be schema/permission related.
      throw createError({ statusCode: 500, statusMessage: orgRes.error.message })
    }
    if (!orgRes.data) {
      // Either the org doesn't exist or RLS hid it. Same response —
      // don't leak presence.
      throw createError({ statusCode: 404, statusMessage: 'Organization not found' })
    }

    const brokerRows = brokersRes.data ?? []

    // Resolve broker profiles separately (PostgREST can't FK-embed
    // from a view). Single IN query keyed by the leaderboard's
    // user_ids, then mapped back onto the rows.
    let brokers = brokerRows
    if (brokerRows.length > 0) {
      const userIds = Array.from(new Set(brokerRows.map((b: any) => b.user_id).filter(Boolean)))
      const { data: profileRows } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', userIds)

      const profileMap = new Map<string, any>()
      for (const p of profileRows ?? []) profileMap.set(p.id, p)
      brokers = brokerRows.map((b: any) => ({
        ...b,
        profile: profileMap.get(b.user_id) ?? null,
      }))
    }

    // Pipeline aggregates: sum across the per-stage rows for the
    // overview header.
    const pipeline = pipelineRes.data ?? []
    const totalDeals     = pipeline.reduce((s: number, r: any) => s + (r.deal_count ?? 0), 0)
    const totalWon       = pipeline.reduce((s: number, r: any) => s + (r.won_count ?? 0), 0)
    const totalLost      = pipeline.reduce((s: number, r: any) => s + (r.lost_count ?? 0), 0)
    const totalGmvWon    = pipeline.reduce((s: number, r: any) => s + Number(r.gmv_won ?? 0), 0)

    return {
      organization: orgRes.data,
      pipeline: {
        by_stage: pipeline,
        totals: {
          deal_count: totalDeals,
          won_count:  totalWon,
          lost_count: totalLost,
          gmv_won:    totalGmvWon,
        },
      },
      branches: branchesRes.data ?? [],
      brokers,
    }
  },
})
