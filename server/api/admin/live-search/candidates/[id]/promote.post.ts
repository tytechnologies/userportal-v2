// Admin — promote an external candidate into listings_raw for full ingest.
//
// POST /api/admin/live-search/candidates/[id]/promote
//
// Copies the external candidate's normalized fields into listings_raw
// so the existing B-3 normalize → apply pipeline picks it up on the
// next worker tick. The candidate's operator_status flips to
// 'promoted' so the admin UI shows the lifecycle event.
//
// Idempotent on (source_id, foreign_id, raw_hash) — re-promoting the
// same candidate after a body edit will land another row in raw, but
// the trigger-computed raw_hash collision prevents duplicate stages.
//
// Requires the candidate's provider_slug to map to a listing_sources
// row (slug match). Returns 422 with a clear hint if not.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const supabase = await serverSupabaseClient(event)

  // 1. Load the candidate.
  const { data: cand, error: candErr } = await (supabase as any)
    .from('external_listing_candidates')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (candErr) {
    throw createError({ statusCode: 500, statusMessage: candErr.message })
  }
  if (!cand) {
    throw createError({ statusCode: 404, statusMessage: 'Candidate not found' })
  }

  // 2. Resolve listing_sources.id by provider_slug. The provider_slug
  //    on source_connectors does NOT necessarily match a listing_sources
  //    slug — partner feeds and Tavily-discovery providers can differ.
  //    Operators who want Tavily candidates to flow into the real
  //    ingest path should pre-create a `listing_sources` row with the
  //    same slug.
  const { data: src, error: srcErr } = await (supabase as any)
    .from('listing_sources')
    .select('id, slug')
    .eq('slug', cand.provider_slug)
    .maybeSingle()
  if (srcErr) {
    throw createError({ statusCode: 500, statusMessage: srcErr.message })
  }
  if (!src) {
    throw createError({
      statusCode: 422,
      statusMessage:
        `No listing_sources row matches provider_slug "${cand.provider_slug}". ` +
        `Create one first via the admin Sources tab.`,
    })
  }

  // 3. Build the listings_raw payload. The table trigger computes
  //    raw_hash on insert; we just need source_id + foreign_id (URL
  //    is the natural partner key for discovery sources) + payload.
  const rawPayload = {
    title:        cand.title,
    description:  cand.description,
    source_url:   cand.source_url,
    source_domain: cand.source_domain,
    price:        cand.price,
    currency:     cand.currency,
    for_sale:     cand.for_sale,
    for_rent:     cand.for_rent,
    property_type: cand.property_type,
    bedrooms:     cand.bedrooms,
    bathrooms:    cand.bathrooms,
    floor_area:   cand.floor_area,
    lot_area:     cand.lot_area,
    address:      cand.address,
    city_slug:    cand.city_slug,
    barangay_slug: cand.barangay_slug,
    latitude:     cand.latitude,
    longitude:    cand.longitude,
    thumbnail_url: cand.thumbnail_url,
    parse_confidence: cand.parse_confidence,
    raw_payload:  cand.raw_payload,
    promoted_from_candidate_id: cand.id,
  }

  const { data: rawRow, error: insErr } = await (supabase as any)
    .from('listings_raw')
    .insert({
      source_id: src.id,
      foreign_id: cand.source_url,
      raw_payload: rawPayload,
    })
    .select('id')
    .single()
  if (insErr) {
    // Most likely: unique constraint hit (this candidate was already
    // promoted with identical content). Treat as success — the dedupe
    // is the contract.
    if (insErr.code === '23505') {
      logger.info(
        { id, provider: cand.provider_slug, op: 'promote.duplicate' },
        'candidate_promote_duplicate_silenced',
      )
    } else {
      throw createError({ statusCode: 500, statusMessage: insErr.message })
    }
  }

  // 4. Mark the candidate promoted.
  const { error: updErr } = await (supabase as any)
    .from('external_listing_candidates')
    .update({ operator_status: 'promoted' })
    .eq('id', id)
  if (updErr) {
    logger.warn(
      { err: updErr.message, op: 'promote.status-update' },
      'candidate_promote_status_failed',
    )
  }

  return {
    ok: true,
    listings_raw_id: rawRow?.id ?? null,
    candidate_id: id,
    next_steps: [
      'The normalize-raw cron will pick this row up within ~5 minutes.',
      'Watch /admin/raw-ingest for the queue depth and per-source rollup.',
    ],
  }
})
