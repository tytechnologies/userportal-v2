import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing document id' })

    const supabase = await serverSupabaseClient(event)
    // Pull metadata too — we need contact_id / listing_id to stamp on the
    // audit row so the unified CRM timeline can pivot on either entity.
    const { data: row, error: fetchError } = await supabase
      .from('documents')
      .select('id, s3_key, document_type, file_name, metadata')
      .eq('id', id)
      .eq('created_by', user.id)
      .single()

    if (fetchError || !row) {
      throw createError({ statusCode: 404, statusMessage: 'Document not found' })
    }

    if (row.s3_key) {
      await deleteObjectsByKeys([row.s3_key])
    }

    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', id)
      .eq('created_by', user.id)

    if (deleteError) {
      logger.error({ err: deleteError.message, id }, 'document_delete_failed')
      throw createError({ statusCode: 500, statusMessage: 'Failed to delete document record' })
    }

    const meta = (row as any).metadata ?? {}
    await logActivity({
      event,
      client: supabase,
      action: 'document.deleted',
      entity: 'document',
      metadata: {
        document_id: id,
        document_type: (row as any).document_type ?? null,
        file_name: (row as any).file_name ?? null,
        contact_id: meta.contact_id ?? null,
        listing_id: meta.listing_id ?? null,
      },
    })

    return { success: true }
  },
})
