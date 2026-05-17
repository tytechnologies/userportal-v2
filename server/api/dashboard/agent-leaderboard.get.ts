// Agent leaderboard for the dashboard. Aggregates per-agent deal
// performance over the active date range:
//   - won_count, won_value     (closed_won = true within window)
//   - open_count, open_value   (closed_won = null right now — snapshot,
//                               independent of the window)
//   - inquiries_handled        (assigned_user_id = X within window)
//
// Sorted by `won_value` DESC, top 10. Manager-or-above only — agents
// don't see their peers' numbers (request is 403'd).
//
// GET /api/dashboard/agent-leaderboard?from=…&to=…
//
// PostgREST has no GROUP BY in the public API; we pull rows + group
// in Node. The dataset is small (deals + inquiries are O(thousands)
// at the brokerage scale this widget runs at), so the bandwidth is
// acceptable. If the org grows past O(10k) deals/period, swap for
// a SECURITY DEFINER aggregation RPC — keep the response shape stable.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { hasRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  from:  z.string().datetime({ offset: true }).optional(),
  to:    z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

type Row = {
  user_id: string
  full_name: string | null
  avatar_url: string | null
  won_count: number
  won_value: number
  open_count: number
  open_value: number
  inquiries_handled: number
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    if (!(await hasRole(event, 'manager'))) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden: manager role required to view leaderboard.',
      })
    }
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    const now = Date.now()
    const fromIso = q.from ?? new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const toIso   = q.to   ?? new Date(now).toISOString()

    // Pull won deals in the window
    const { data: wonRows, error: wonErr } = await (supabase as any)
      .from('deals')
      .select('buyer_agent_user_id, deal_value')
      .eq('closed_won', true)
      .gte('closed_at', fromIso)
      .lte('closed_at', toIso)
    if (wonErr) {
      logger.warn({ err: wonErr.message, op: 'agent_leaderboard.won' }, 'leaderboard_won_failed')
    }

    // Pull open deals (snapshot — current state, ignores window)
    const { data: openRows, error: openErr } = await (supabase as any)
      .from('deals')
      .select('buyer_agent_user_id, deal_value')
      .is('closed_won', null)
    if (openErr) {
      logger.warn({ err: openErr.message, op: 'agent_leaderboard.open' }, 'leaderboard_open_failed')
    }

    // Pull inquiries handled in the window
    const { data: inqRows, error: inqErr } = await (supabase as any)
      .from('inquiries')
      .select('assigned_user_id')
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
    if (inqErr) {
      logger.warn({ err: inqErr.message, op: 'agent_leaderboard.inq' }, 'leaderboard_inq_failed')
    }

    // Aggregate
    const acc = new Map<string, Omit<Row, 'full_name' | 'avatar_url'>>()
    function bump(uid: string | null, mut: (r: Omit<Row, 'full_name' | 'avatar_url'>) => void) {
      if (!uid) return
      const existing = acc.get(uid) ?? {
        user_id: uid,
        won_count: 0, won_value: 0,
        open_count: 0, open_value: 0,
        inquiries_handled: 0,
      }
      mut(existing)
      acc.set(uid, existing)
    }

    for (const r of (wonRows ?? []) as Array<{ buyer_agent_user_id: string | null; deal_value: number | null }>) {
      bump(r.buyer_agent_user_id, (e) => {
        e.won_count += 1
        e.won_value += Number(r.deal_value ?? 0)
      })
    }
    for (const r of (openRows ?? []) as Array<{ buyer_agent_user_id: string | null; deal_value: number | null }>) {
      bump(r.buyer_agent_user_id, (e) => {
        e.open_count += 1
        e.open_value += Number(r.deal_value ?? 0)
      })
    }
    for (const r of (inqRows ?? []) as Array<{ assigned_user_id: string | null }>) {
      bump(r.assigned_user_id, (e) => {
        e.inquiries_handled += 1
      })
    }

    // Sort: primary won_value DESC, tiebreak won_count DESC, then open_value DESC.
    const sorted = Array.from(acc.values()).sort((a, b) => {
      if (b.won_value !== a.won_value) return b.won_value - a.won_value
      if (b.won_count !== a.won_count) return b.won_count - a.won_count
      return b.open_value - a.open_value
    })
    const top = sorted.slice(0, q.limit)

    // Hydrate name + avatar in one round trip
    const ids = top.map((r) => r.user_id)
    const profileById = new Map<string, { full_name: string | null; avatar_url: string | null }>()
    if (ids.length > 0) {
      const { data: profs } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', ids)
      for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null; avatar_url: string | null }>) {
        profileById.set(p.id, { full_name: p.full_name, avatar_url: p.avatar_url })
      }
    }

    const items: Row[] = top.map((r) => {
      const prof = profileById.get(r.user_id)
      return {
        ...r,
        full_name: prof?.full_name ?? null,
        avatar_url: prof?.avatar_url ?? null,
      }
    })

    return {
      items,
      period_from: fromIso,
      period_to: toIso,
      currency: 'PHP',
    }
  },
})
