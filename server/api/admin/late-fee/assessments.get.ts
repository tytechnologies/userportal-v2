// List late-fee assessments across all leases.
//
// GET /api/admin/late-fee/assessments?lease_id=&from=&to=&limit=&offset=
//
// Joins to property_charges + leases for context (charge_no on the
// late_fee charge + parent rent_charge_no via metadata + lease unit_id).
// Without filters returns the most recent 50 across all leases.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  lease_id: z.string().uuid().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD')
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()

    // Pull assessments + the late-fee charge they created. The
    // assessment's `metadata` carries the source charge id so the UI
    // can drill back to the rent/dues row that triggered the fee.
    let q: any = (admin as any)
      .from('late_fee_assessments')
      .select(`
        id, source_charge_id, late_fee_charge_id, policy_id,
        payment_run_id, assessment_date, recurrence_index,
        amount_minor, metadata, created_at,
        late_fee_charge:property_charges!late_fee_assessments_late_fee_charge_id_fkey (
          id, charge_no, kind, status, total_minor, currency,
          due_at, paid_at, lease_id, unit_id
        ),
        source_charge:property_charges!late_fee_assessments_source_charge_id_fkey (
          id, charge_no, kind, status, total_minor, currency,
          due_at, lease_id
        )
      `, { count: 'estimated' })
      .order('assessment_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(query.offset!, query.offset! + query.limit! - 1)

    if (query.lease_id) {
      // Filter by the source charge's lease — that's the lease the
      // late fee belongs to (the late_fee charge inherits the same).
      q = q.eq('source_charge.lease_id', query.lease_id)
    }
    if (query.from) q = q.gte('assessment_date', query.from)
    if (query.to) q = q.lte('assessment_date', query.to)

    const { data, error, count } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      rows: data ?? [],
      total: count ?? (data?.length ?? 0),
      limit: query.limit,
      offset: query.offset,
    }
  },
})
