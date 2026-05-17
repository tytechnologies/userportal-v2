// Stale listings = online + not updated for ≥ N days. The portal's
// search/feed surfaces drift down listings that haven't been refreshed,
// so flagging stale rows on the dashboard turns a silent decay into
// an actionable widget.
//
// RLS scopes the result to what the caller can see (own/team/all per
// their listings.read.* permissions). Default threshold is 30 days,
// override via ?days=N (7–365). Returns up to ?limit=N rows
// (1–50, default 10) plus a total count for the badge.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { resolveDashboardScope } from '~~/server/utils/dashboardScope'

const querySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const q = query as z.infer<typeof querySchema>
    const cutoffIso = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000).toISOString()
    const scope = await resolveDashboardScope(event, supabase)

    // Brokers/agents see only listings they created. Admins keep
    // platform-wide. listing_details (MV) carries created_by — it's
    // excluded only from the anon public_listing_details view.
    async function countSafe(): Promise<number> {
      let qb: any = (supabase as any)
        .from('listing_details')
        .select('listing_id', { count: 'exact', head: true })
        .eq('is_online', true)
        .lte('updated_at', cutoffIso)
      qb = scope.scopeListings(qb)
      const { count, error } = await qb
      if (error) {
        logger.warn({ err: error.message, op: 'dashboard.stale.count' }, 'stale_count_failed')
        return 0
      }
      return count ?? 0
    }

    async function rowsSafe(): Promise<any[]> {
      let qb: any = (supabase as any)
        .from('listing_details')
        .select('listing_id, title, property_category, city_name, updated_at')
        .eq('is_online', true)
        .lte('updated_at', cutoffIso)
      qb = scope.scopeListings(qb)
      const { data, error } = await qb
        .order('updated_at', { ascending: true })
        .limit(q.limit)
      if (error) {
        logger.warn({ err: error.message, op: 'dashboard.stale.rows' }, 'stale_rows_failed')
        return []
      }
      return data ?? []
    }

    const [total, rows] = await Promise.all([countSafe(), rowsSafe()])

    return {
      total,
      threshold_days: q.days,
      data: rows,
    }
  },
})
