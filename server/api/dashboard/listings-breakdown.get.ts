// Listings inventory breakdown — current state (snapshot, no date
// range). Counts the visible listings in 4 buckets:
//
//   - sale_only   — online, for_sale=true,  for_rent=false
//   - rent_only   — online, for_sale=false, for_rent=true
//   - both        — online, for_sale=true,  for_rent=true
//   - offline     — not online, not deleted (drafts / archived)
//
// All counts are 'estimated' for the listings table (per the rule
// to avoid full-table 'exact' counts which time out — see
// dashboard/stats.get.ts header comment). Estimates are accurate
// within a few % at brokerage scale; fine for an inventory glance.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { resolveDashboardScope } from '~~/server/utils/dashboardScope'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const supabase = await serverSupabaseClient(event)
    const scope = await resolveDashboardScope(event, supabase)

    async function countSafe(builderFactory: () => any): Promise<number> {
      try {
        const { count, error } = await builderFactory()
        if (error) {
          logger.warn({ err: error.message, op: 'dashboard.listings_breakdown' }, 'breakdown_count_failed')
          return 0
        }
        return count ?? 0
      } catch (err: any) {
        logger.warn({ err: err?.message, op: 'dashboard.listings_breakdown' }, 'breakdown_count_threw')
        return 0
      }
    }

    // Estimate-vs-exact: admins keep 'estimated' (table-wide scan
    // would time out at 49k+ rows); brokers/agents get 'exact' since
    // their scoped slice is small.
    const countMode = scope.isAdmin ? 'estimated' : 'exact'
    const [saleOnly, rentOnly, both, offline, residential, commercial] = await Promise.all([
      countSafe(() =>
        scope.scopeListings(
          (supabase as any)
            .from('listings')
            .select('id', { count: countMode, head: true })
            .eq('is_online', true).is('deleted_at', null)
            .eq('for_sale', true).eq('for_rent', false),
        ),
      ),
      countSafe(() =>
        scope.scopeListings(
          (supabase as any)
            .from('listings')
            .select('id', { count: countMode, head: true })
            .eq('is_online', true).is('deleted_at', null)
            .eq('for_sale', false).eq('for_rent', true),
        ),
      ),
      countSafe(() =>
        scope.scopeListings(
          (supabase as any)
            .from('listings')
            .select('id', { count: countMode, head: true })
            .eq('is_online', true).is('deleted_at', null)
            .eq('for_sale', true).eq('for_rent', true),
        ),
      ),
      // Offline: not online AND not deleted (drafts the operator can
      // still see + edit but the public site hides).
      countSafe(() =>
        scope.scopeListings(
          (supabase as any)
            .from('listings')
            .select('id', { count: countMode, head: true })
            .eq('is_online', false).is('deleted_at', null),
        ),
      ),
      countSafe(() =>
        scope.scopeListings(
          (supabase as any)
            .from('listings')
            .select('id', { count: countMode, head: true })
            .eq('is_online', true).is('deleted_at', null)
            .eq('property_category', 'residential'),
        ),
      ),
      countSafe(() =>
        scope.scopeListings(
          (supabase as any)
            .from('listings')
            .select('id', { count: countMode, head: true })
            .eq('is_online', true).is('deleted_at', null)
            .eq('property_category', 'commercial'),
        ),
      ),
    ])

    const onlineTotal = saleOnly + rentOnly + both
    const total = onlineTotal + offline

    return {
      online: {
        sale_only: saleOnly,
        rent_only: rentOnly,
        both: both,
        residential,
        commercial,
        total: onlineTotal,
      },
      offline,
      total,
    }
  },
})
