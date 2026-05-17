// Delete a government reference document. Admin-gated via RLS. Cleans
// up the S3 object too — leaving orphan files in the bucket adds up.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const supabase = await serverSupabaseClient(event)

    // Pull s3_key first so we can clean up the file after the row is gone.
    const { data: row, error: fetchError } = await (supabase as any)
      .from('government_documents')
      .select('id, s3_key')
      .eq('id', id)
      .maybeSingle()
    if (fetchError) throw createError({ statusCode: 500, statusMessage: fetchError.message })
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })

    const { error: delError } = await (supabase as any)
      .from('government_documents')
      .delete()
      .eq('id', id)
    if (delError) {
      logger.error({ err: delError.message, op: 'gov_docs.delete', id }, 'gov_docs_delete_failed')
      throw createError({ statusCode: 500, statusMessage: delError.message })
    }

    if (row.s3_key) {
      try { await deleteObjectsByKeys([row.s3_key]) }
      catch (e) {
        logger.warn(
          { err: (e as Error).message, s3Key: row.s3_key },
          'gov_docs_s3_cleanup_failed',
        )
      }
    }

    return { success: true }
  },
})
