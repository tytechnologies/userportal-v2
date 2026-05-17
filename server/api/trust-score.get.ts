// Read trust score for a target.
//
// GET /api/trust-score?target_type=agent&target_id=<uuid>
// Auth: optional (anonymous public read — view's data is non-PII).
//
// Reads public.trust_score view. Cheap (indexed aggregations); the
// website can hit this on every agent/building page render.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  target_type: z.enum(['agent', 'building', 'developer', 'listing', 'owner']),
  target_id: z.string().min(1).max(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'optional',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    setHeader(event, 'Cache-Control', 'public, max-age=60, stale-while-revalidate=120')

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('trust_score')
      .select('*')
      .eq('target_type', q.target_type)
      .eq('target_id', q.target_id)
      .maybeSingle()

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    if (!data) {
      // No reviews yet → return a structured zero-state rather than
      // 404 so the website can render "No reviews yet" without a
      // separate exists-check round trip.
      return {
        target_type: q.target_type,
        target_id: q.target_id,
        review_count: 0,
        avg_rating: null,
        trust_score: null,
        verified: false,
      }
    }
    return data
  },
})
