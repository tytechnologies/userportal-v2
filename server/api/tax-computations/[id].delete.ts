// Delete a tax computation record. RLS gates this to the owner +
// anyone with tax_computations.write.all (admins).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const supabase = await serverSupabaseClient(event)
    const { error, count } = await (supabase as any)
      .from('tax_computations')
      .delete({ count: 'exact' })
      .eq('id', id)

    if (error) {
      logger.error({ err: error.message, op: 'tax_computations.delete', id }, 'tax_computations_delete_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (count === 0) {
      throw createError({ statusCode: 404, statusMessage: 'Tax computation not found' })
    }

    return { success: true }
  },
})
