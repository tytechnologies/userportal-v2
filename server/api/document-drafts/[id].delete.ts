// Delete a draft. RLS gates the operation (own / admin). If the row
// pointed at an imported S3 object, we delete that too — otherwise
// orphaned files accumulate.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)
    const { data: row, error: fetchError } = await (supabase as any)
      .from('document_drafts')
      .select('id, storage_path')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      logger.error({ err: fetchError.message, id }, 'document_draft_delete_fetch_failed')
      throw createError({ statusCode: 500, statusMessage: fetchError.message })
    }
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })

    // Best-effort S3 cleanup for imported drafts. Failure here is logged
    // but we still proceed with the row delete — orphaned file is
    // preferable to a row+file mismatch.
    if (row.storage_path) {
      try {
        await deleteObjectsByKeys([row.storage_path])
      } catch (e) {
        logger.warn({ err: (e as Error).message, id }, 'document_draft_storage_cleanup_failed')
      }
    }

    const { error: deleteError } = await (supabase as any)
      .from('document_drafts')
      .delete()
      .eq('id', id)

    if (deleteError) {
      logger.error({ err: deleteError.message, id }, 'document_draft_delete_failed')
      throw createError({ statusCode: 500, statusMessage: deleteError.message })
    }
    return { success: true }
  },
})
