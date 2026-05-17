// Admin — paginated properties list with variant-count + source-mix.
//
// GET /api/admin/properties?
//   q=                — fuzzy name / street_address match (trigram)
//   city_id=          — exact match
//   category=         — exact match (residential|commercial)
//   property_type=    — exact match (condo|house|...)
//   has_pinned_primary= true|false — filter on properties.primary_listing_id
//   internal_only=    true — properties with internal_authoritative=true
//   page=
//   page_size=        — default 25, max 100
//
// Returns each property's pinned/elected primary listing ids, variant
// count (= listings sharing property_id), and the source mix (counts
// of internal vs source-imported variants).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  q:                  z.string().trim().min(1).max(200).optional(),
  city_id:            z.coerce.number().int().positive().optional(),
  category:           z.enum(['residential', 'commercial']).optional(),
  property_type:      z.string().trim().min(1).max(40).optional(),
  has_pinned_primary: z.enum(['true', 'false']).optional(),
  internal_only:      z.enum(['true', 'false']).optional(),
  page:               z.coerce.number().int().min(1).default(1),
  page_size:          z.coerce.number().int().min(1).max(100).default(25),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)
    const from = (q.page - 1) * q.page_size
    const to = from + q.page_size - 1

    // 1) Page of properties — filters + pagination at the DB.
    //    `count: 'planned'` to avoid full-scan timeouts on the
    //    properties table at scale.
    let req: any = (supabase as any)
      .from('properties')
      .select(
        'id, name, slug, street_address, category, type, ' +
          'city_id, barangay_id, primary_listing_id, internal_authoritative, ' +
          'created_at, updated_at',
        { count: 'planned' },
      )
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (q.q) {
      // pg_trgm `%` operator already supported on properties via
      // 510000003 (street_address GIN trgm). Fall back to ILIKE on
      // name when the user's query doesn't trigger the index.
      req = req.or(
        `name.ilike.%${q.q.replace(/[%_]/g, '')}%,street_address.ilike.%${q.q.replace(/[%_]/g, '')}%`,
      )
    }
    if (q.city_id != null)        req = req.eq('city_id', q.city_id)
    if (q.category)               req = req.eq('category', q.category)
    if (q.property_type)          req = req.eq('type', q.property_type)
    if (q.has_pinned_primary === 'true')  req = req.not('primary_listing_id', 'is', null)
    if (q.has_pinned_primary === 'false') req = req.is('primary_listing_id', null)
    if (q.internal_only === 'true')       req = req.eq('internal_authoritative', true)

    const { data: properties, error, count } = await req
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!properties || properties.length === 0) {
      return {
        properties: [], total: count ?? 0, page: q.page, page_size: q.page_size,
      }
    }

    const propertyIds = (properties as any[]).map((p) => p.id)
    const cityIds     = Array.from(new Set((properties as any[]).map((p) => p.city_id).filter(Boolean)))
    const barangayIds = Array.from(new Set((properties as any[]).map((p) => p.barangay_id).filter(Boolean)))

    // 2) Variant counts + source mix per property, in one shot.
    //    Use the listings table directly with a planned count.
    //    listings is the highest-volume table on the platform; per
    //    feedback_count_exact_on_listings, we NEVER use count('exact')
    //    on listings — we aggregate client-side from a bounded fetch.
    const { data: variantRows } = await (supabase as any)
      .from('listings')
      .select('id, property_id, source_id, is_online, deleted_at')
      .in('property_id', propertyIds)

    const variantByProp = new Map<number, {
      total: number; live: number; internal: number; source: number;
    }>()
    for (const v of (variantRows ?? []) as any[]) {
      const slot = variantByProp.get(v.property_id) ?? {
        total: 0, live: 0, internal: 0, source: 0,
      }
      slot.total += 1
      if (v.is_online && !v.deleted_at) slot.live += 1
      if (v.source_id) slot.source += 1
      else slot.internal += 1
      variantByProp.set(v.property_id, slot)
    }

    // 3) City + barangay resolution.
    const [cityRes, barangayRes] = await Promise.all([
      cityIds.length > 0
        ? (supabase as any).from('cities').select('id, name, slug').in('id', cityIds)
        : Promise.resolve({ data: [] }),
      barangayIds.length > 0
        ? (supabase as any).from('barangays').select('id, name, slug').in('id', barangayIds)
        : Promise.resolve({ data: [] }),
    ])
    const cityMap     = new Map<number, any>((cityRes.data     ?? []).map((c: any) => [c.id, c]))
    const barangayMap = new Map<number, any>((barangayRes.data ?? []).map((b: any) => [b.id, b]))

    const enriched = (properties as any[]).map((p) => {
      const variants = variantByProp.get(p.id) ?? { total: 0, live: 0, internal: 0, source: 0 }
      return {
        ...p,
        city:     p.city_id     ? cityMap.get(p.city_id)     ?? null : null,
        barangay: p.barangay_id ? barangayMap.get(p.barangay_id) ?? null : null,
        variants,
      }
    })

    return {
      properties: enriched,
      total:      count ?? 0,
      page:       q.page,
      page_size:  q.page_size,
    }
  },
})
