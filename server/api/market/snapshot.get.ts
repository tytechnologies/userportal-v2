// Market snapshot — inventory + velocity for a city × property_type.
//
// GET /api/market/snapshot?city_id=...&property_type=condominium
// Auth: required. RLS on the underlying views permits authenticated.
//
// Returns inventory_summary + velocity + top buildings in that city.
// `sufficient_data` flag is false when the segment has fewer than
// MIN_SAMPLE listings so the UI can show "not enough data" instead
// of a misleading median.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const MIN_SAMPLE = 5

const querySchema = z.object({
  city_id:       z.coerce.number().int().positive().optional(),
  property_type: z.string().trim().min(1).max(64).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)

    let invReq: any = (supabase as any)
      .from('market_inventory_summary')
      .select('city_id, property_type, listing_count, available_count, reserved_count, sold_count, median_price, p25_price, p75_price, median_price_per_sqm, avg_price')
    let velReq: any = (supabase as any)
      .from('market_velocity')
      .select('city_id, property_type, active_listings, avg_dom_days, median_dom_days, p75_dom_days, deals_closed_30d, deals_closed_90d, gmv_90d, absorption_rate_30d')

    if (q.city_id != null)       { invReq = invReq.eq('city_id', q.city_id);       velReq = velReq.eq('city_id', q.city_id) }
    if (q.property_type)         { invReq = invReq.eq('property_type', q.property_type); velReq = velReq.eq('property_type', q.property_type) }

    const [invRes, velRes] = await Promise.all([invReq, velReq])
    if (invRes.error) throw createError({ statusCode: 500, statusMessage: invRes.error.message })
    if (velRes.error) throw createError({ statusCode: 500, statusMessage: velRes.error.message })

    const inventory = (invRes.data ?? []).map((r: any) => ({
      ...r,
      sufficient_data: (r.listing_count ?? 0) >= MIN_SAMPLE,
    }))

    // Top buildings within the requested city — only when one is
    // specified (otherwise the result set is too large to be useful).
    let top_buildings: any[] = []
    if (q.city_id != null) {
      const { data: buildings } = await (supabase as any)
        .from('building_market_summary')
        .select('building_id, building_name, building_slug, listing_count, median_price, median_price_per_sqm, deals_won_90d, gmv_90d, trust_score, review_count')
        .eq('city_id', q.city_id)
        .gte('listing_count', MIN_SAMPLE)
        .order('listing_count', { ascending: false })
        .limit(10)
      top_buildings = buildings ?? []
    }

    return {
      filter:    { city_id: q.city_id ?? null, property_type: q.property_type ?? null },
      inventory,
      velocity:  velRes.data ?? [],
      top_buildings,
      min_sample: MIN_SAMPLE,
    }
  },
})
