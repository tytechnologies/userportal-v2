// Hot-area detection — top-N hot barangays for a city.
//
// GET /api/market/hot-areas?city_id=&limit=20
//
// Wraps market_hot_areas() RPC. Returns the per-barangay hot_score
// + the per-component contribution so the UI can render
// "why this is hot."
//
// We resolve barangay names + city names server-side so the UI
// can render labels without an extra round-trip.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  city_id: z.coerce.number().int().positive().optional(),
  limit:   z.coerce.number().int().min(1).max(50).default(20),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)

    const { data: rows, error } = await (supabase as any).rpc('market_hot_areas', {
      p_city_id: q.city_id ?? null,
      p_limit:   q.limit,
    })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    if (!rows || rows.length === 0) {
      return { city_id: q.city_id ?? null, areas: [] }
    }

    // Resolve barangay + city names. Tiny join — the limit is ≤50,
    // so two IN-queries by id are cheap.
    const barangayIds = Array.from(new Set(rows.map((r: any) => r.barangay_id).filter(Boolean)))
    const cityIds     = Array.from(new Set(rows.map((r: any) => r.city_id).filter(Boolean)))

    const [barangayRes, cityRes] = await Promise.all([
      barangayIds.length > 0
        ? (supabase as any).from('barangays').select('id, name').in('id', barangayIds)
        : Promise.resolve({ data: [] }),
      cityIds.length > 0
        ? (supabase as any).from('cities').select('id, name').in('id', cityIds)
        : Promise.resolve({ data: [] }),
    ])

    const barangayMap = new Map<number, string>()
    for (const b of barangayRes.data ?? []) barangayMap.set(b.id, b.name)
    const cityMap = new Map<number, string>()
    for (const c of cityRes.data ?? []) cityMap.set(c.id, c.name)

    const areas = rows.map((r: any) => ({
      ...r,
      barangay_name: barangayMap.get(r.barangay_id) ?? null,
      city_name:     cityMap.get(r.city_id) ?? null,
    }))

    return { city_id: q.city_id ?? null, areas }
  },
})
