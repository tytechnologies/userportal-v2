// Delete a building. Listings linked via building_id have their FK
// nulled (ON DELETE SET NULL); the legacy property_id / property_name
// columns on listings are left untouched, so listing display doesn't
// break — it just loses the FK link.
//
// RLS limits this to buildings.manage roles.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const raw = getRouterParam(event, 'id')
    const id = Number(raw)
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid building id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { error, count } = await (supabase as any)
      .from('buildings')
      .delete({ count: 'exact' })
      .eq('id', id)

    if (error) {
      logger.error({ err: error.message, op: 'buildings.delete', id }, 'buildings_delete_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    // count = 0 when RLS hid the row (or it didn't exist) — same UX
    // either way: 404.
    if (!count) throw createError({ statusCode: 404, statusMessage: 'Building not found or not deletable' })
    return { success: true }
  },
})
