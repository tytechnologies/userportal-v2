// Market trends — month-by-month line chart data.
//
// GET /api/market/trends?city_id=...&property_type=...&months=12
// Auth: required.
//
// Reads mv_market_monthly_trends (refreshed nightly). Default 12
// months back from now.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  city_id:       z.coerce.number().int().positive().optional(),
  property_type: z.string().trim().min(1).max(64).optional(),
  months:        z.coerce.number().int().min(1).max(60).default(12),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)

    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - q.months)
    const cutoffIso = cutoff.toISOString().slice(0, 10)

    let req: any = (supabase as any)
      .from('mv_market_monthly_trends')
      .select('month_start, city_id, property_type, listings_created, median_price, median_price_per_sqm, avg_price')
      .gte('month_start', cutoffIso)
      .order('month_start', { ascending: true })
    if (q.city_id != null)       req = req.eq('city_id', q.city_id)
    if (q.property_type)         req = req.eq('property_type', q.property_type)

    const { data, error } = await req
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return {
      filter: {
        city_id:       q.city_id ?? null,
        property_type: q.property_type ?? null,
        months:        q.months,
      },
      trends: data ?? [],
    }
  },
})
