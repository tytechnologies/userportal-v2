// Import an external file (PDF/image/DOCX) as a document_drafts row.
// The client sends a base64 payload alongside the metadata; the server
// uploads to the existing S3 bucket under document-drafts/<id>/<file>
// and creates the row with storage_path populated.
//
// Why base64 over multipart: the rest of the project (viewing-list-pdf
// upload, generate-docx) already uses base64 + JSON, and h3's body
// parser is much friendlier to JSON than to multipart in this Nuxt
// version. If file sizes ever cross ~50 MB, switch to a presigned-PUT
// flow.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { uploadObject, deleteObjectsByKeys, getS3 } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  // Filename for display + storage path. Sanitized below.
  file_name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(120),
  // Base64-encoded file body (without data URL prefix).
  file_base64: z.string().min(1).max(120_000_000), // ~90 MB raw
  contact_id: z.number().int().positive().nullable().optional(),
  title: z.string().max(200).optional(),
})

function sanitizeFileName(name: string): string {
  // Strip path separators and unprintables; collapse whitespace.
  return name
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\-+ ]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 200) || 'upload'
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const supabase = await serverSupabaseClient(event)

    // Decode the base64 payload up front so we can reject malformed
    // input before touching S3.
    let buffer: Buffer
    try {
      buffer = Buffer.from(body.file_base64, 'base64')
    } catch (e) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid base64 payload' })
    }
    if (buffer.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Empty file body' })
    }

    const safeName = sanitizeFileName(body.file_name)
    const userId = user?.id ?? 'anon'

    // Insert the row first WITHOUT storage_path so we get a stable id
    // to use as the S3 prefix. We then update with storage details and
    // clean up if the upload fails.
    const initialInsert = {
      template_id: null,
      contact_id: body.contact_id ?? null,
      data: { file_name: safeName, mime_type: body.mime_type },
      title: body.title ?? safeName,
    }

    const { data: row, error: insertError } = await (supabase as any)
      .from('document_drafts')
      .insert(initialInsert)
      .select('id')
      .single()

    if (insertError || !row?.id) {
      logger.error(
        { err: insertError?.message, op: 'document_drafts.import.insert' },
        'document_draft_import_insert_failed',
      )
      throw createError({ statusCode: 500, statusMessage: insertError?.message ?? 'Failed to create draft row' })
    }

    const s3Key = `document-drafts/${userId}/${row.id}/${safeName}`
    const { bucket } = getS3()

    try {
      await uploadObject(s3Key, buffer)
    } catch (e: any) {
      // Roll back the row so we never have a dangling import record.
      await (supabase as any).from('document_drafts').delete().eq('id', row.id)
      logger.error(
        { err: e?.message, s3Key, id: row.id },
        'document_draft_import_upload_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Failed to upload file to storage.' })
    }

    const { data: updated, error: updateError } = await (supabase as any)
      .from('document_drafts')
      .update({
        storage_path: s3Key,
        storage_bucket: bucket,
        storage_mime: body.mime_type,
        storage_size_bytes: buffer.length,
      })
      .eq('id', row.id)
      .select('*')
      .single()

    if (updateError) {
      // S3 succeeded, DB metadata write failed. Clean up the upload
      // and surface the error rather than leaving a row missing its
      // storage pointer.
      try {
        await deleteObjectsByKeys([s3Key])
      } catch (cleanupErr) {
        logger.error(
          { err: (cleanupErr as Error).message, s3Key },
          'document_draft_import_cleanup_failed',
        )
      }
      await (supabase as any).from('document_drafts').delete().eq('id', row.id)
      throw createError({ statusCode: 500, statusMessage: updateError.message })
    }

    setResponseStatus(event, 201)
    return updated
  },
})
