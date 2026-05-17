// Admin: read the active tenant statement policy for a lease.
//
// GET /api/admin/leases/[id]/tenant-statement-policy
//
// Returns the active row (one-per-lease partial UNIQUE) or null if
// the lease has no auto-statement schedule (operator must issue
// statements manually via the existing tenant_statements path).

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const leaseId = getRouterParam(event, 'id')
    if (!leaseId || !/^[0-9a-f-]{36}$/i.test(leaseId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }

    const admin = getServerSupabaseAdmin()
    const { data, error } = await (admin as any)
      .from('tenant_statement_policies')
      .select('*')
      .eq('lease_id', leaseId)
      .eq('status', 'active')
      .is('ended_at', null)
      .order('effective_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { policy: data ?? null }
  },
})
