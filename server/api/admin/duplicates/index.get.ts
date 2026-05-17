// Admin — list duplicate-candidate review queue.
//
// GET /api/admin/duplicates?status=pending&page=1&page_size=20
// Auth: admin (admin.access permission, RLS-gated).
//
// Resolves both listings' titles + sale_price + building_id +
// created_by + thumbnails server-side so the review UI doesn't have
// to fan out to per-listing reads.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status:    z.enum(['pending', 'confirmed_duplicate', 'distinct', 'dismissed']).default('pending'),
  page:      z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    // 1. Pull the candidate page.
    const from = (q.page - 1) * q.page_size
    const to = from + q.page_size - 1

    const { data: candidates, error, count } = await (supabase as any)
      .from('listing_duplicate_candidates')
      .select(
        'id, a_listing_id, b_listing_id, confidence, signals, status, ' +
        'reviewed_by, reviewed_at, review_notes, detected_at, detected_run, ' +
        'canonical_listing_id, merged_listing_id, merged_at',
        { count: 'exact' },
      )
      .eq('status', q.status)
      .order('confidence', { ascending: false })
      .order('detected_at', { ascending: false })
      .range(from, to)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    if (!candidates || candidates.length === 0) {
      return { candidates: [], total: count ?? 0, page: q.page, page_size: q.page_size }
    }

    // 2. Resolve listing details for both sides in one IN-query.
    const allIds = Array.from(new Set(
      candidates.flatMap((c: any) => [c.a_listing_id, c.b_listing_id]),
    ))
    const { data: listings } = await (supabase as any)
      .from('listings')
      .select('id, title, sale_price, rent_price, floor_area, bedrooms, bathrooms, building_id, created_by, created_at, is_online, deleted_at')
      .in('id', allIds)

    const byId = new Map<number, any>()
    for (const l of listings ?? []) byId.set(l.id, l)

    // 3. Resolve broker names so the UI can show "Both posted by [Name]"
    //    without an extra fetch per row.
    const brokerIds = Array.from(new Set(
      (listings ?? []).map((l: any) => l.created_by).filter(Boolean),
    ))
    let brokerMap = new Map<string, any>()
    if (brokerIds.length > 0) {
      const { data: brokers } = await (supabase as any)
        .from('profiles')
        .select('id, full_name')
        .in('id', brokerIds)
      for (const b of brokers ?? []) brokerMap.set(b.id, b)
    }

    const enriched = candidates.map((c: any) => {
      const a = byId.get(c.a_listing_id)
      const b = byId.get(c.b_listing_id)
      return {
        ...c,
        a: a ? { ...a, broker: a.created_by ? brokerMap.get(a.created_by) ?? null : null } : null,
        b: b ? { ...b, broker: b.created_by ? brokerMap.get(b.created_by) ?? null : null } : null,
      }
    })

    return {
      candidates: enriched,
      total:     count ?? 0,
      page:      q.page,
      page_size: q.page_size,
    }
  },
})
