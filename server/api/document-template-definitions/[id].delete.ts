// Delete a template definition. Best-effort S3 cleanup of the
// background image; the row delete is the source of truth.
//
// IMPORTANT: this does NOT cascade to document_drafts that point at
// this template_id. Drafts continue to exist with a now-dangling
// template_id. The editor handles that gracefully (renders the empty
// "no template loaded" state) but admins should consider archiving
// instead of deleting when there are live drafts.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing template id' })

    const supabase = await serverSupabaseClient(event)
    const { data: row, error: fetchError } = await (supabase as any)
      .from('document_template_definitions')
      .select('id, background_path')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      logger.error({ err: fetchError.message, id }, 'template_defs_delete_fetch_failed')
      throw createError({ statusCode: 500, statusMessage: fetchError.message })
    }
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Template not found' })

    const { error: deleteError } = await (supabase as any)
      .from('document_template_definitions')
      .delete()
      .eq('id', id)
    if (deleteError) {
      logger.error({ err: deleteError.message, id }, 'template_defs_delete_failed')
      throw createError({ statusCode: 500, statusMessage: deleteError.message })
    }

    if (row.background_path) {
      try { await deleteObjectsByKeys([row.background_path]) }
      catch (e) {
        logger.warn(
          { err: (e as Error).message, id, path: row.background_path },
          'template_defs_background_cleanup_failed',
        )
      }
    }
    return { success: true }
  },
})
