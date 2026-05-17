// Replace the file attached to a government reference document.
//
// Same upload + decode pattern as /api/government-documents (POST), but
// scoped to mutating one row's s3_key + file_name + file_format. Old
// S3 object is deleted on success — no orphans accumulate when an
// editor swaps a file.
//
// Admin-gated via the gov_docs_write RLS policy + the matching
// permission (gov_docs.write). RLS on the SELECT before update will
// 404 if the caller can't write.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { uploadObject, deleteObjectsByKeys, decodeDataUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  file_data_url: z.string().min(20).max(50_000_000),
  file_name: z.string().min(1).max(255),
})

const ALLOWED_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx'])

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\-+ ]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 200) || 'document'
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const supabase = await serverSupabaseClient(event)

    // Look up the existing row first so we can:
    //   1. 404 if the caller can't see / write it (RLS).
    //   2. Capture the old s3_key for cleanup after the swap.
    //   3. Decide which S3 prefix folder to use (matches the row's category).
    const { data: existing, error: fetchError } = await (supabase as any)
      .from('government_documents')
      .select('id, category, s3_key')
      .eq('id', id)
      .maybeSingle()
    if (fetchError) throw createError({ statusCode: 500, statusMessage: fetchError.message })
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Document not found' })

    let s3Key: string
    let fileFormat: string
    const safeName = sanitizeFileName(body.file_name)
    let buffer: Buffer

    // PDF goes through manual base64 decode; image variants delegate
    // to the canonical helper which validates the data-URL shape.
    const pdfMatch = body.file_data_url.match(/^data:application\/pdf;base64,/)
    if (pdfMatch) {
      const base64 = body.file_data_url.replace(/^data:application\/pdf;base64,/, '')
      buffer = Buffer.from(base64, 'base64')
      if (buffer.length === 0) {
        throw createError({ statusCode: 400, statusMessage: 'Empty PDF body' })
      }
      fileFormat = 'pdf'
    } else {
      const decoded = decodeDataUrl(body.file_data_url)
      if (!ALLOWED_FORMATS.has(decoded.extension)) {
        throw createError({
          statusCode: 422,
          statusMessage: `Unsupported file type: ${decoded.extension}`,
        })
      }
      buffer = decoded.body
      fileFormat = decoded.extension === 'jpeg' ? 'jpg' : decoded.extension
    }

    // Cache-buster timestamp on the key so signed URLs that may have
    // been bookmarked don't accidentally hit the new file under the
    // same path.
    s3Key = `government-documents/${existing.category}/${Date.now()}-${safeName}`

    try {
      await uploadObject(s3Key, buffer)
    } catch (e: any) {
      logger.error({ err: e?.message, id, s3Key }, 'gov_docs_file_upload_failed')
      throw createError({ statusCode: 500, statusMessage: 'Upload failed.' })
    }

    const { data: updated, error: updateError } = await (supabase as any)
      .from('government_documents')
      .update({
        s3_key: s3Key,
        file_name: safeName,
        file_format: fileFormat,
      })
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (updateError) {
      // Row update failed — clean up the freshly-uploaded file so it
      // doesn't orphan in the bucket.
      try { await deleteObjectsByKeys([s3Key]) }
      catch (cleanupErr) {
        logger.error(
          { err: (cleanupErr as Error).message, s3Key },
          'gov_docs_file_orphan_cleanup_failed',
        )
      }
      throw createError({ statusCode: 500, statusMessage: updateError.message })
    }

    // Best-effort delete of the previous file. Failure here just leaks
    // one stale object — not worth failing the user-visible swap.
    if (existing.s3_key && existing.s3_key !== s3Key) {
      try { await deleteObjectsByKeys([existing.s3_key]) }
      catch (e) {
        logger.warn(
          { err: (e as Error).message, prev: existing.s3_key },
          'gov_docs_old_file_cleanup_failed',
        )
      }
    }

    return updated
  },
})
