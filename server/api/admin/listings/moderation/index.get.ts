// Admin — listing moderation queue.
//
// GET /api/admin/listings/moderation?status=pending&page=&page_size=&source_id=
//
// Returns listings awaiting publish review, with the operationally
// relevant signals attached: quality score, image count, duplicate
// candidate count, broker + organization, source batch.
//
// status filter:
//   'pending'    → is_online=false AND deleted_at IS NULL  (default)
//   'published'  → is_online=true  AND deleted_at IS NULL  (recently approved)
//   'rejected'   → deleted_at IS NOT NULL                  (recently soft-deleted)

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status:    z.enum(['pending', 'published', 'rejected']).default('pending'),
  page:      z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  source_id: z.coerce.number().int().positive().optional(),
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

    // 1. Pull the listings page.
    let req: any = (supabase as any)
      .from('listings')
      .select(
        'id, title, description, sale_price, rent_price, ' +
        'property_category, property_type, ' +
        'bedrooms, bathrooms, floor_area, ' +
        'city_id, barangay_id, building_id, ' +
        'created_by, source_id, is_online, deleted_at, created_at',
        // 'planned' avoids the full-table-scan timeout on listings.
        // Pagination accuracy is fine within a few %; user paginates
        // by clicking next/prev not by jumping to a precise count.
        { count: 'planned' },
      )
      .order('created_at', { ascending: false })
      .range(from, to)

    if (q.status === 'pending') {
      req = req.eq('is_online', false).is('deleted_at', null)
    } else if (q.status === 'published') {
      // Recently published — limit to last 7 days so the tab doesn't
      // turn into a full archive view.
      const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
      req = req.eq('is_online', true).is('deleted_at', null).gte('created_at', cutoff)
    } else if (q.status === 'rejected') {
      const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
      req = req.not('deleted_at', 'is', null).gte('deleted_at', cutoff)
    }
    if (q.source_id != null) req = req.eq('source_id', q.source_id)

    const { data: listings, error, count } = await req
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    if (!listings || listings.length === 0) {
      return { listings: [], total: count ?? 0, page: q.page, page_size: q.page_size }
    }

    const listingIds = listings.map((l: any) => l.id)
    const cityIds    = Array.from(new Set(listings.map((l: any) => l.city_id).filter(Boolean)))
    const barangayIds = Array.from(new Set(listings.map((l: any) => l.barangay_id).filter(Boolean)))
    const buildingIds = Array.from(new Set(listings.map((l: any) => l.building_id).filter(Boolean)))
    const brokerIds  = Array.from(new Set(listings.map((l: any) => l.created_by).filter(Boolean)))

    // 2. Resolve all reference data in parallel — small IN-queries.
    const [cityRes, barangayRes, buildingRes, brokerRes, qualityRes, imageRes, dupRes, sourceRes] =
      await Promise.all([
        cityIds.length > 0
          ? (supabase as any).from('cities').select('id, name, slug').in('id', cityIds)
          : Promise.resolve({ data: [] }),
        barangayIds.length > 0
          ? (supabase as any).from('barangays').select('id, name, slug').in('id', barangayIds)
          : Promise.resolve({ data: [] }),
        buildingIds.length > 0
          ? (supabase as any).from('buildings').select('id, name, slug').in('id', buildingIds)
          : Promise.resolve({ data: [] }),
        brokerIds.length > 0
          ? (supabase as any).from('profiles').select('id, full_name, email').in('id', brokerIds)
          : Promise.resolve({ data: [] }),
        // Quality MV refreshes hourly; brand-new listings may be absent.
        (supabase as any).from('listing_quality').select('listing_id, total_score').in('listing_id', listingIds),
        // listing_images may not exist on every environment; soft-fail.
        (supabase as any).from('listing_images').select('listing_id').in('listing_id', listingIds).then(
          (r: any) => r.error ? { data: [] } : r,
        ),
        // Pending duplicate candidates referencing either side.
        (supabase as any).from('listing_duplicate_candidates')
          .select('id, a_listing_id, b_listing_id, confidence, status')
          .or(
            `a_listing_id.in.(${listingIds.join(',')}),b_listing_id.in.(${listingIds.join(',')})`,
          )
          .eq('status', 'pending'),
        // Source for attribution.
        (supabase as any).from('listing_sources').select('id, slug, display_name'),
      ])

    const cityMap     = new Map<number, any>((cityRes.data ?? []).map((r: any) => [r.id, r]))
    const barangayMap = new Map<number, any>((barangayRes.data ?? []).map((r: any) => [r.id, r]))
    const buildingMap = new Map<number, any>((buildingRes.data ?? []).map((r: any) => [r.id, r]))
    const brokerMap   = new Map<string, any>((brokerRes.data ?? []).map((r: any) => [r.id, r]))
    const qualityMap  = new Map<number, number>((qualityRes.data ?? []).map((r: any) => [r.listing_id, Number(r.total_score)]))
    const sourceMap   = new Map<number, any>((sourceRes.data ?? []).map((r: any) => [r.id, r]))

    const imageCountMap = new Map<number, number>()
    for (const r of imageRes.data ?? []) {
      imageCountMap.set(r.listing_id, (imageCountMap.get(r.listing_id) ?? 0) + 1)
    }

    const dupCountMap = new Map<number, number>()
    for (const d of dupRes.data ?? []) {
      const a = d.a_listing_id, b = d.b_listing_id
      dupCountMap.set(a, (dupCountMap.get(a) ?? 0) + 1)
      dupCountMap.set(b, (dupCountMap.get(b) ?? 0) + 1)
    }

    const enriched = listings.map((l: any) => ({
      ...l,
      broker:    l.created_by ? brokerMap.get(l.created_by) ?? null : null,
      city:      l.city_id ? cityMap.get(l.city_id) ?? null : null,
      barangay:  l.barangay_id ? barangayMap.get(l.barangay_id) ?? null : null,
      building:  l.building_id ? buildingMap.get(l.building_id) ?? null : null,
      source:    l.source_id ? sourceMap.get(l.source_id) ?? null : null,
      image_count: imageCountMap.get(l.id) ?? 0,
      quality_score: qualityMap.get(l.id) ?? null,
      duplicate_candidate_count: dupCountMap.get(l.id) ?? 0,
    }))

    return {
      listings:  enriched,
      total:     count ?? 0,
      page:      q.page,
      page_size: q.page_size,
    }
  },
})
