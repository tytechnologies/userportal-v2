// GET /api/admin/owner-statements?status=issued
//
// Cross-cutting list of owner_statements for the admin/property-manager
// dashboard. RLS already gates the underlying table to property.manage
// or admin.access; this endpoint is the explicit aggregated path so
// the UI doesn't iterate per-owner.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  status: z.enum(['draft', 'issued', 'disbursed', 'void']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('owner_statements')
      .select(
        'id, owner_id, statement_no, period_start, period_end, currency, ' +
          'rent_collected_minor, dues_collected_minor, expenses_minor, ' +
          'management_fee_minor, tax_withheld_minor, net_disbursement_minor, ' +
          'line_items, status, issued_at, disbursed_at, voided_at, void_reason, ' +
          'external_reference, created_at, updated_at',
      )
      .order('period_start', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(query.limit ?? 200)
    if (query.status) q = q.eq('status', query.status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
