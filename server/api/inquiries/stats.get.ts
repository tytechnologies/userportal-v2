// Cheap stats endpoint for inquiry dashboards. The legacy
// residential/commercial split is computed by reading category-keyed
// listing ids first then counting inquiries scoped to those ids —
// avoids the PostgREST `listings!inner(property_category)` inner-join
// which 500s in some environments where the inquiries→listings FK
// relationship isn't introspectable from the schema cache.
//
// Each count uses head:true so only Content-Range comes back, no
// rows. Failures are logged + swallowed so a partial outage doesn't
// blank the dashboard.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const supabase = await serverSupabaseClient(event)

    async function listingIdsByCategory(category: 'residential' | 'commercial'): Promise<number[]> {
      const { data, error } = await (supabase as any)
        .from('listings')
        .select('id')
        .eq('property_category', category)
      if (error) {
        logger.warn({ err: error.message, op: 'inquiries.stats.listing_ids', category }, 'inquiry_stats_listings_failed')
        return []
      }
      return ((data ?? []) as Array<{ id: number }>).map(r => r.id)
    }

    async function countNewInquiriesIn(ids: number[]): Promise<number> {
      if (ids.length === 0) return 0
      const { count, error } = await (supabase as any)
        .from('inquiries')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'new')
        .in('listing_id', ids)
      if (error) {
        logger.warn({ err: error.message, op: 'inquiries.stats.count' }, 'inquiry_stats_count_failed')
        return 0
      }
      return count ?? 0
    }

    const [residentialIds, commercialIds, total, mineNew] = await Promise.all([
      listingIdsByCategory('residential'),
      listingIdsByCategory('commercial'),
      // Total new visible (RLS-scoped).
      (async () => {
        const { count } = await (supabase as any)
          .from('inquiries')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'new')
        return count ?? 0
      })(),
      // Caller's own backlog.
      (async () => {
        const { count } = await (supabase as any)
          .from('inquiries')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'new')
          .eq('assigned_user_id', user!.id)
        return count ?? 0
      })(),
    ])

    const [residential, commercial] = await Promise.all([
      countNewInquiriesIn(residentialIds),
      countNewInquiriesIn(commercialIds),
    ])

    return { residential, commercial, total, mine_new: mineNew }
  },
})
