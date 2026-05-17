// Sign a fresh download URL for an existing document_exports row.
//
// GET /api/document-exports/:id/download
//
// Why a separate endpoint instead of just storing URLs on the row:
// signed S3 URLs expire (we issue 1h TTLs from the export endpoint).
// Re-signing on demand keeps the panel's "Download" button working
// indefinitely without storing a long-lived public URL anywhere.
//
// RLS on document_exports gates the read; the broker can only sign
// exports tied to drafts they can see.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedDownloadUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

const paramsSchema = z.object({
  id: z.string().uuid(),
})

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const params = paramsSchema.parse({ id: getRouterParam(event, 'id') })
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('document_exports')
      .select('id, draft_id, format, storage_path, byte_length, generated_at')
      .eq('id', params.id)
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'document_exports.download' }, 'doc_export_download_lookup_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Export not found' })

    const url = await getSignedDownloadUrl(data.storage_path, 3_600)
    return { ...data, url, url_expires_in: 3_600 }
  },
})
