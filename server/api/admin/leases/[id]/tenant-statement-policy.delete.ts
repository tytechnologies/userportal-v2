// Admin: opt the lease out of auto-statements.
//
// DELETE /api/admin/leases/[id]/tenant-statement-policy
//
// Soft-ends the active policy. Past-issued tenant_statements are
// preserved (the post_guard locks issued statements anyway).
// Idempotent when no active policy exists.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

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
      .update({ ended_at: new Date().toISOString(), status: 'paused' })
      .eq('lease_id', leaseId)
      .eq('status', 'active')
      .is('ended_at', null)
      .select('id')

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const endedCount = (data as Array<{ id: string }> | null)?.length ?? 0

    await logActivity({
      event,
      action: 'tenant_statement_policy.opted_out',
      entity: 'lease' as any,
      entityId: leaseId,
      metadata: { ended_count: endedCount },
    })

    return { lease_id: leaseId, ended: endedCount > 0, ended_count: endedCount }
  },
})
