// Listing quality score breakdown.
//
// GET /api/listings/:id/quality
// Auth: required. RLS gates listing visibility upstream.
//
// Returns the listing_quality view row for a listing. Components
// are explicit (image, description, verification, freshness, etc.)
// so the broker UI can show "your score is 65 because...".
//
// Accepts both uuid and numeric ids per the schema-drift convention.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const ID_RE = /^([0-9a-f-]{36}|[0-9]+)$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')

    const id = getRouterParam(event, 'id') || ''
    if (!ID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('listing_quality')
      .select('listing_id, total_score, score_images, score_description, score_verification, score_freshness, score_responsiveness, score_broker_trust, score_price_alignment, score_geography, computed_at')
      .eq('listing_id', id)
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    if (!data) {
      // The MV refreshes hourly; brand-new listings won't appear
      // until the next refresh. Communicate that rather than 404.
      return {
        listing_id: id,
        total_score: null,
        components: null,
        computed_at: null,
        pending: true,
        message: 'Quality score is computed hourly; this listing has not been included in the latest refresh yet.',
      }
    }

    // Surface as a structured "components" array so the UI can
    // render a stacked bar without hardcoding labels.
    const components = [
      { key: 'images',          label: 'Images',                value: Number(data.score_images),         max: 20 },
      { key: 'description',     label: 'Description',           value: Number(data.score_description),    max: 15 },
      { key: 'verification',    label: 'Verification',          value: Number(data.score_verification),   max: 15 },
      { key: 'freshness',       label: 'Freshness',             value: Number(data.score_freshness),      max: 10 },
      { key: 'responsiveness',  label: 'Inquiry response rate', value: Number(data.score_responsiveness), max: 15 },
      { key: 'broker_trust',    label: 'Broker trust',          value: Number(data.score_broker_trust),   max: 10 },
      { key: 'price_alignment', label: 'Price vs. zonal',       value: Number(data.score_price_alignment), max: 10 },
      { key: 'geography',       label: 'Geographic completeness', value: Number(data.score_geography),    max: 5 },
    ]

    return {
      listing_id:  data.listing_id,
      total_score: Number(data.total_score),
      components,
      computed_at: data.computed_at,
      pending:     false,
    }
  },
})
