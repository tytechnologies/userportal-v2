// Load a single document draft by id. RLS gates which rows the caller
// can see; a 404 is returned if the row is missing OR hidden.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_drafts')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'document_drafts.getById', id }, 'document_draft_get_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Document draft not found' })
    return data
  },
})
