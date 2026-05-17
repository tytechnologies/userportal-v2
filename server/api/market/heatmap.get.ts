// Generic heatmap endpoint — routes mode → RPC.
//
// GET /api/market/heatmap?mode=pricing|demand|inventory|trust|luxury|velocity
//                       &min_lat=&min_lng=&max_lat=&max_lng=&cell=0.01
//
// Each mode wraps a distinct RPC shipped in mig 28 / 32. The mode→RPC
// mapping is hardcoded server-side so a malformed `mode` value can't
// reach PostgREST; we resolve to a fixed allowlist or 400.
//
// Privacy: every backing RPC enforces ≥3 (or ≥5 for trust/luxury)
// HAVING clause — no single-listing cells reach the response.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  mode:     z.enum(['pricing', 'demand', 'inventory', 'trust', 'luxury', 'velocity']),
  min_lat:  z.coerce.number(),
  min_lng:  z.coerce.number(),
  max_lat:  z.coerce.number(),
  max_lng:  z.coerce.number(),
  cell:     z.coerce.number().min(0.001).max(1).default(0.01),
})

const MODE_TO_RPC: Record<string, string> = {
  pricing:   'market_pricing_heatmap_grid',
  demand:    'market_demand_heatmap_grid',
  inventory: 'market_inventory_heatmap_grid',
  trust:     'market_trust_heatmap_grid',
  luxury:    'market_luxury_heatmap_grid',
  velocity:  'market_velocity_heatmap_grid',
}

// Each mode declares which numeric column the UI should color by.
// Returned in the response so the renderer doesn't have to guess.
const MODE_VALUE_COLUMN: Record<string, string> = {
  pricing:   'median_price_per_sqm',
  demand:    'inquiry_count_30d',
  inventory: 'available_count',
  trust:     'avg_trust_score',
  luxury:    'luxury_pct',
  velocity:  'median_dom_days',
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    // Sanity-check the bounds. Inverted bbox returns nothing useful.
    if (q.min_lat >= q.max_lat || q.min_lng >= q.max_lng) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid bounding box' })
    }

    const supabase = await serverSupabaseClient(event)
    const rpc = MODE_TO_RPC[q.mode]

    const { data, error } = await (supabase as any).rpc(rpc, {
      p_min_lat:        q.min_lat,
      p_min_lng:        q.min_lng,
      p_max_lat:        q.max_lat,
      p_max_lng:        q.max_lng,
      p_cell_size_deg:  q.cell,
    })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      mode:         q.mode,
      value_column: MODE_VALUE_COLUMN[q.mode],
      cell_size:    q.cell,
      bounds:       { min_lat: q.min_lat, min_lng: q.min_lng, max_lat: q.max_lat, max_lng: q.max_lng },
      cells:        data ?? [],
    }
  },
})
