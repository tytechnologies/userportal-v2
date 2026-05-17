// List inspections for a lease.
//
// GET /api/leases/[id]/inspections
//
// Auth: any caller who can read the lease can read the inspection
// list. RLS on `public.inspections` enforces this — we don't add a
// second layer of RBAC here.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const leaseId = getRouterParam(event, 'id')
    if (!leaseId || !/^[0-9a-f-]{36}$/i.test(leaseId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }

    // RLS-respecting client (caller's JWT). The lease's tenant party
    // gets read access to their own inspection list this way.
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('inspections')
      .select(`
        id, inspection_no, unit_id, lease_id, inspection_kind, status,
        inspector_user_id, inspector_external_name,
        scheduled_at, conducted_at,
        overall_condition, total_damage_estimate_minor,
        tenant_signed_at, summary_notes,
        created_at, updated_at
      `)
      .eq('lease_id', leaseId)
      .order('scheduled_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(query.limit)

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { items: data ?? [] }
  },
})
