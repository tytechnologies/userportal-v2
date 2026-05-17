// Intelligent listing discovery — opt-in.
//
// GET /api/listings/discover?sort_mode=recommended&city_id=...&property_type=...&limit=24
// Auth: required.
//
// Reads listing_discovery_score for the chosen mode and joins to
// listings for hydration. Existing /api/public/listings is
// untouched — this endpoint is the opt-in intelligent surface.
//
// sort_mode values come from search_sort_modes registry. The view
// has one column per mode (recommended_score, quality_score_sort,
// trusted_score, etc.); we resolve the mode → column at request
// time and pass it as the order column.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  sort_mode:     z.string().trim().min(1).max(64).default('recommended'),
  city_id:       z.coerce.number().int().positive().optional(),
  property_type: z.string().trim().min(1).max(64).optional(),
  min_price:     z.coerce.number().int().positive().optional(),
  max_price:     z.coerce.number().int().positive().optional(),
  bedrooms_min:  z.coerce.number().int().min(0).optional(),
  limit:         z.coerce.number().int().min(1).max(100).default(24),
  offset:        z.coerce.number().int().min(0).default(0),
})

// Allowed score columns — matches the view's column list. Hardcoded
// (rather than reading search_sort_modes at request time) to defend
// against SQL injection via the order column. The mode_key resolves
// to one of these or fails with 400.
const SCORE_COLUMNS: Record<string, string> = {
  recommended:     'recommended_score',
  highest_quality: 'quality_score_sort',
  trusted:         'trusted_score',
  fastest_moving:  'fastest_moving_score',
  undervalued:     'undervalued_score',
  luxury_priority: 'luxury_score',
  newest:          'newest_score',
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const scoreColumn = SCORE_COLUMNS[q.sort_mode]
    if (!scoreColumn) {
      throw createError({
        statusCode: 400,
        statusMessage: `Unknown sort_mode "${q.sort_mode}". Valid: ${Object.keys(SCORE_COLUMNS).join(', ')}`,
      })
    }

    const supabase = await serverSupabaseClient(event)

    // Step 1: pull the top-N listing_ids by score from the discovery
    // view, applying segment filters. The view has city_id +
    // property_type for cheap filtering before sort.
    let scoreReq: any = (supabase as any)
      .from('listing_discovery_score')
      .select(`listing_id, ${scoreColumn}, quality_score, broker_trust_score`)
      .order(scoreColumn, { ascending: false, nullsFirst: false })
      .range(q.offset, q.offset + q.limit - 1)

    if (q.city_id != null)       scoreReq = scoreReq.eq('city_id', q.city_id)
    if (q.property_type)         scoreReq = scoreReq.eq('property_type', q.property_type)

    const { data: scoreRows, error: scoreErr } = await scoreReq
    if (scoreErr) {
      throw createError({ statusCode: 500, statusMessage: scoreErr.message })
    }
    const ids = (scoreRows ?? []).map((r: any) => r.listing_id)
    if (ids.length === 0) {
      return { sort_mode: q.sort_mode, listings: [], count: 0 }
    }

    // Step 2: hydrate listing rows. Only the fields the discovery
    // grid renders — no JOIN to building/profile yet (the website's
    // listings.get.ts pattern owns full hydration).
    let listingReq: any = (supabase as any)
      .from('listings')
      .select('id, title, sale_price, rent_price, bedrooms, bathrooms, floor_area, lot_area, property_type, property_category, city_id, barangay_id, building_id, is_online, created_at')
      .in('id', ids)
      .eq('is_online', true)
      .is('deleted_at', null)

    if (q.min_price != null)    listingReq = listingReq.gte('sale_price', q.min_price)
    if (q.max_price != null)    listingReq = listingReq.lte('sale_price', q.max_price)
    if (q.bedrooms_min != null) listingReq = listingReq.gte('bedrooms', q.bedrooms_min)

    const { data: listings, error: listErr } = await listingReq
    if (listErr) throw createError({ statusCode: 500, statusMessage: listErr.message })

    // Re-order client-side to honor the score order (PostgREST .in()
    // doesn't preserve order). Annotate each row with its score so
    // the UI can render a "score: 78" tooltip.
    const orderById = new Map<number, number>()
    const scoreById = new Map<number, any>()
    ;(scoreRows ?? []).forEach((r: any, idx: number) => {
      orderById.set(r.listing_id, idx)
      scoreById.set(r.listing_id, {
        score:        Number(r[scoreColumn]),
        quality:      Number(r.quality_score),
        broker_trust: Number(r.broker_trust_score),
      })
    })

    const result = (listings ?? [])
      .filter((l: any) => orderById.has(l.id))
      .sort((a: any, b: any) => (orderById.get(a.id)! - orderById.get(b.id)!))
      .map((l: any) => ({ ...l, _discovery: scoreById.get(l.id) }))

    return {
      sort_mode: q.sort_mode,
      score_column: scoreColumn,
      listings: result,
      count: result.length,
      filter: {
        city_id:       q.city_id ?? null,
        property_type: q.property_type ?? null,
        min_price:     q.min_price ?? null,
        max_price:     q.max_price ?? null,
        bedrooms_min:  q.bedrooms_min ?? null,
      },
    }
  },
})
