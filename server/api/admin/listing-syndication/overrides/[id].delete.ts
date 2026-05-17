// Remove a per-listing override.
//
// DELETE /api/admin/listing-syndication/overrides/[id]

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid override id' })
    }

    const admin = getServerSupabaseAdmin()
    const { data: existing } = await (admin as any)
      .from('listing_syndication_overrides')
      .select('id, target_id, listing_id, override_kind')
      .eq('id', id)
      .maybeSingle()

    const { error } = await (admin as any)
      .from('listing_syndication_overrides')
      .delete()
      .eq('id', id)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      action: 'syndication.override_deleted',
      entity: 'syndication_target' as any,
      entityId: existing?.target_id ?? id,
      metadata: existing ?? { override_id: id },
    })

    return { id, deleted: true }
  },
})
