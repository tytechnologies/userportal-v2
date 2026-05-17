// GET /api/admin/tenant-statements?status=issued
//
// Cross-cutting list of tenant_statements for the admin dashboard.
// RLS already gates the underlying table; this endpoint just
// short-circuits per-lease iteration.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  status: z.enum(['draft', 'issued', 'paid', 'overdue', 'void']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('tenant_statements')
      .select(
        'id, lease_id, tenant_party_id, statement_no, period_start, period_end, ' +
          'currency, rent_billed_minor, other_charges_minor, payments_received_minor, ' +
          'balance_due_minor, line_items, status, issued_at, due_at, paid_at, ' +
          'voided_at, void_reason, created_at, updated_at',
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
