// Hard-delete a listing share. RLS limits this to the listing's owner
// or listings.write.all admins. Recipients should use PATCH
// status='revoked' to decline instead of hard-deleting.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid share id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { error, count } = await (supabase as any)
      .from('listing_shares')
      .delete({ count: 'exact' })
      .eq('id', id)

    if (error) {
      logger.error({ err: error.message, op: 'listing_shares.delete', id }, 'listing_shares_delete_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!count) throw createError({ statusCode: 404, statusMessage: 'Share not found or not deletable' })
    return { success: true }
  },
})
