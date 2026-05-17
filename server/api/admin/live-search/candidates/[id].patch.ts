// Admin — update a single external_listing_candidate.
//
// PATCH /api/admin/live-search/candidates/[id]
// Body: { operator_status?, dedup_status?, canonical_property_id?, match_confidence? }
//
// Operators use this to:
//   - blacklist junk (operator_status = 'blacklisted'): never resurface.
//     The hybrid orchestrator still re-fetches from Tavily but the
//     adapter's already-seen-URL check (table UNIQUE on (provider_slug,
//     source_url)) preserves the blacklisted state on re-touch.
//   - mark as promoted (operator_status = 'promoted') after the row
//     was copied to listings_raw via the /promote endpoint.
//   - manually pin a dedup match (canonical_property_id + match_confidence)
//     when the runtime dedup engine missed a clear pair.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const bodySchema = z.object({
  operator_status: z.enum(['surfaced', 'blacklisted', 'promoted']).optional(),
  dedup_status: z.enum([
    'unmatched',
    'matched_provisional',
    'matched_confirmed',
    'distinct',
  ]).optional(),
  canonical_property_id: z.number().int().positive().nullable().optional(),
  match_confidence: z.number().min(0).max(1).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Invalid body',
      data: { issues: parsed.error.issues },
    })
  }
  const patch = parsed.data
  if (Object.keys(patch).length === 0) {
    throw createError({ statusCode: 422, statusMessage: 'No fields to update' })
  }

  const supabase = await serverSupabaseClient(event)
  const { data, error } = await (supabase as any)
    .from('external_listing_candidates')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'Candidate not found' })
  }
  return { ok: true, candidate: data }
})
