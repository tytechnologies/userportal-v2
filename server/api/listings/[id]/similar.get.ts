// Similar listings — deterministic weighted similarity.
//
// GET /api/listings/:id/similar?limit=10
// Auth: required.
//
// Calls similar_listings(p_listing_id, p_limit) RPC. The RPC returns
// id + similarity_score + match_reasons. We hydrate the listing rows
// in a follow-up query (PostgREST cannot embed FK joins from a
// SETOF function result) and return them sorted by similarity.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

const ID_RE = /^([0-9a-f-]{36}|[0-9]+)$/i

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const id = getRouterParam(event, 'id') || ''
    if (!ID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const supabase = await serverSupabaseClient(event)

    const { data: matches, error: rpcErr } = await (supabase as any).rpc('similar_listings', {
      p_listing_id: id,
      p_limit:      q.limit,
    })
    if (rpcErr) {
      throw createError({ statusCode: 500, statusMessage: rpcErr.message })
    }

    if (!matches || matches.length === 0) {
      return { source_id: id, similar: [] }
    }

    const ids = matches.map((m: any) => m.listing_id)
    const { data: listings, error: listErr } = await (supabase as any)
      .from('listings')
      .select('id, title, sale_price, rent_price, bedrooms, bathrooms, floor_area, property_type, city_id, barangay_id, building_id')
      .in('id', ids)
      .eq('is_online', true)
      .is('deleted_at', null)
    if (listErr) throw createError({ statusCode: 500, statusMessage: listErr.message })

    const matchMap = new Map<number, any>()
    for (const m of matches) matchMap.set(m.listing_id, m)

    const similar = (listings ?? [])
      .filter((l: any) => matchMap.has(l.id))
      .map((l: any) => {
        const m = matchMap.get(l.id)
        return {
          ...l,
          similarity_score: m.similarity_score,
          match_reasons:    m.match_reasons || [],
        }
      })
      .sort((a: any, b: any) => b.similarity_score - a.similarity_score)

    return { source_id: id, similar }
  },
})
