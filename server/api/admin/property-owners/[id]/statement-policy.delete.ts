// Admin: opt the owner out of auto-statements.
//
// DELETE /api/admin/property-owners/[id]/statement-policy
// Soft-ends the active policy. Past-issued owner_statements preserved.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const ownerId = getRouterParam(event, 'id')
    if (!ownerId || !/^[0-9a-f-]{36}$/i.test(ownerId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid owner id' })
    }

    const admin = getServerSupabaseAdmin()
    const { data, error } = await (admin as any)
      .from('owner_statement_policies')
      .update({ ended_at: new Date().toISOString(), status: 'paused' })
      .eq('property_owner_id', ownerId)
      .eq('status', 'active')
      .is('ended_at', null)
      .select('id')

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const endedCount = (data as Array<{ id: string }> | null)?.length ?? 0

    await logActivity({
      event,
      action: 'owner_statement_policy.opted_out',
      entity: 'property_owner' as any,
      entityId: ownerId,
      metadata: { ended_count: endedCount },
    })

    return { property_owner_id: ownerId, ended: endedCount > 0, ended_count: endedCount }
  },
})
