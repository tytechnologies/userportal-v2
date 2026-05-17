// Admin — list rows for a listing import batch (drilldown).
//
// GET /api/admin/listings/import/:id/rows?outcome=&page=&page_size=

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

const querySchema = z.object({
  outcome:   z.string().trim().max(40).optional(),
  page:      z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid batch id' })
    }
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)
    const from = (q.page - 1) * q.page_size
    const to = from + q.page_size - 1

    let req: any = (supabase as any)
      .from('listing_import_rows')
      .select(
        'id, row_number, title, sale_price, rent_price, ' +
        'organization_slug, broker_email, city_slug, barangay_slug, building_name, ' +
        'outcome, outcome_detail, processed_at, ' +
        'resolved_listing_id, resolved_building_id, resolved_broker_id, resolved_org_id',
        { count: 'exact' },
      )
      .eq('batch_id', id)
      .order('row_number', { ascending: true })
      .range(from, to)
    if (q.outcome) req = req.eq('outcome', q.outcome)

    const { data, error, count } = await req
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return {
      rows:      data ?? [],
      total:     count ?? 0,
      page:      q.page,
      page_size: q.page_size,
    }
  },
})
