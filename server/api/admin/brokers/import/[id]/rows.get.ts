// Admin — list rows for a broker import batch.
//
// GET /api/admin/brokers/import/:id/rows?outcome=&page=&page_size=
// Drilldown for a specific batch. Filter by outcome to focus on
// errors / pending / specific resolution paths.

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
      .from('broker_import_rows')
      .select(
        'id, row_number, email, full_name, mobile_number, ' +
        'organization_slug, branch_slug, org_role, ' +
        'outcome, outcome_detail, processed_at, ' +
        'resolved_profile_id, resolved_invitation_id, resolved_membership_id',
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
