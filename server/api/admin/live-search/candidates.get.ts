// Admin — paginated list of external listing candidates.
//
// GET /api/admin/live-search/candidates
//   ?provider=&dedup_status=&operator_status=&city_slug=&min_confidence=
//   &page=&per_page=
//
// Auth: admin.access via RLS (table policy ext_candidates_admin_all).
//
// Powers the /admin/external-candidates review page. Each candidate is
// a normalized external hit the hybrid orchestrator surfaced at some
// point. Operators triage: blacklist junk, promote useful ones into
// listings_raw for full ingest, or leave them in "surfaced" for the
// dedup engine to resolve over time.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  provider: z.string().max(80).optional(),
  dedup_status: z.enum([
    'unmatched',
    'matched_provisional',
    'matched_confirmed',
    'distinct',
  ]).optional(),
  operator_status: z.enum(['surfaced', 'blacklisted', 'promoted']).optional(),
  city_slug: z.string().max(80).optional(),
  min_parse_confidence: z.coerce.number().min(0).max(1).optional(),
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
})

export default defineEventHandler(async (event) => {
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Invalid query',
      data: { issues: parsed.error.issues },
    })
  }
  const p = parsed.data
  const supabase = await serverSupabaseClient(event)

  const from = (p.page - 1) * p.per_page
  const to = from + p.per_page - 1

  let q: any = (supabase as any)
    .from('external_listing_candidates')
    .select(
      'id, provider_slug, source_url, source_domain, title, price, currency, for_sale, for_rent, property_type, bedrooms, bathrooms, floor_area, city_slug, latitude, longitude, thumbnail_url, parse_confidence, dedup_status, canonical_property_id, match_confidence, operator_status, surface_count, first_surfaced_at, last_surfaced_at, created_at, updated_at',
      { count: 'exact' },
    )
    .order('last_surfaced_at', { ascending: false })
    .range(from, to)

  if (p.provider)        q = q.eq('provider_slug', p.provider)
  if (p.dedup_status)    q = q.eq('dedup_status', p.dedup_status)
  if (p.operator_status) q = q.eq('operator_status', p.operator_status)
  if (p.city_slug)       q = q.eq('city_slug', p.city_slug)
  if (p.min_parse_confidence != null) {
    q = q.gte('parse_confidence', p.min_parse_confidence)
  }
  if (p.q) {
    // Cheap free-text filter — PostgREST `ilike` over title.
    q = q.ilike('title', `%${p.q.replace(/[%_]/g, '')}%`)
  }

  const { data, count, error } = await q
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  const total = count ?? 0
  return {
    items: data ?? [],
    total,
    page: p.page,
    perPage: p.per_page,
    totalPages: Math.max(1, Math.ceil(total / p.per_page)),
  }
})
