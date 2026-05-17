// List inspections across all leases.
//
// GET /api/admin/inspections?status=&kind=&unit_id=&lease_id=&limit=&offset=
//
// Cross-lease browse for operators (the per-lease list lives at
// GET /api/leases/[id]/inspections). Returns the same shape +
// pagination + estimated count.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status: z
    .enum(['scheduled', 'in_progress', 'completed', 'tenant_signed', 'cancelled'])
    .optional(),
  kind: z
    .enum(['move_in', 'move_out', 'mid_tenancy', 'maintenance', 'annual'])
    .optional(),
  unit_id: z.string().uuid().optional(),
  lease_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()
    let q: any = (admin as any)
      .from('inspections')
      .select(
        'id, inspection_no, unit_id, lease_id, inspection_kind, status, ' +
          'inspector_user_id, inspector_external_name, scheduled_at, ' +
          'conducted_at, overall_condition, total_damage_estimate_minor, ' +
          'tenant_signed_at, summary_notes, created_at',
        { count: 'estimated' },
      )
      .order('scheduled_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(query.offset!, query.offset! + query.limit! - 1)

    if (query.status) q = q.eq('status', query.status)
    if (query.kind) q = q.eq('inspection_kind', query.kind)
    if (query.unit_id) q = q.eq('unit_id', query.unit_id)
    if (query.lease_id) q = q.eq('lease_id', query.lease_id)

    const { data, error, count } = await q
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return {
      rows: data ?? [],
      total: count ?? (data?.length ?? 0),
      limit: query.limit,
      offset: query.offset,
    }
  },
})
