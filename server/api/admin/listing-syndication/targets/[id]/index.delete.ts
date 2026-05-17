// Soft-archive a syndication target.
//
// DELETE /api/admin/listing-syndication/targets/[id]
//
// Sets status='archived'. The public route refuses to serve archived
// targets. Past runs are preserved (run_kind audit). To fully delete,
// operator goes through SQL â€” keeps the audit trail intact by default.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid target id' })
    }

    const admin = getServerSupabaseAdmin()
    const { data, error } = await (admin as any)
      .from('listing_syndication_targets')
      .update({ status: 'archived' })
      .eq('id', id)
      .neq('status', 'archived')
      .select('id')

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const archived = (data as Array<{ id: string }> | null)?.length ?? 0

    await logActivity({
      event,
      action: 'syndication.target_archived',
      entity: 'syndication_target' as any,
      entityId: id,
      metadata: { archived_count: archived },
    })

    return { id, archived: archived > 0 }
  },
})
