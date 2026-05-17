// Upload (or replace) a template's background image. Base64 in JSON
// for parity with the rest of the project's upload endpoints. RLS gates
// the row update, so non-admins can't replace someone else's
// background even if they reach this URL.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { uploadObject, deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  file_name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(120),
  // Cap matches the document-drafts importer.
  file_base64: z.string().min(1).max(120_000_000),
  width: z.number().int().min(100).max(5000).optional(),
  height: z.number().int().min(100).max(7000).optional(),
})

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\-+ ]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 200) || 'background'
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing template id' })

    const supabase = await serverSupabaseClient(event)

    // Look up the row first — pulls the previous background path so we
    // can clean up the orphan on success.
    const { data: existing, error: fetchError } = await (supabase as any)
      .from('document_template_definitions')
      .select('id, background_path')
      .eq('id', id)
      .maybeSingle()
    if (fetchError) {
      throw createError({ statusCode: 500, statusMessage: fetchError.message })
    }
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Template not found' })

    let buffer: Buffer
    try { buffer = Buffer.from(body.file_base64, 'base64') }
    catch { throw createError({ statusCode: 400, statusMessage: 'Invalid base64 payload' }) }
    if (buffer.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Empty file body' })
    }

    const safeName = sanitizeFileName(body.file_name)
    const s3Key = `document-templates/${id}/background-${Date.now()}-${safeName}`

    try { await uploadObject(s3Key, buffer) }
    catch (e: any) {
      logger.error({ err: e?.message, id, s3Key }, 'template_defs_background_upload_failed')
      throw createError({ statusCode: 500, statusMessage: 'Upload failed.' })
    }

    const update: Record<string, unknown> = {
      background_path: s3Key,
      background_name: safeName,
      background_mime: body.mime_type,
    }
    if (body.width !== undefined) update.width = body.width
    if (body.height !== undefined) update.height = body.height

    const { data: updated, error: updateError } = await (supabase as any)
      .from('document_template_definitions')
      .update(update)
      .eq('id', id)
      .select('*')
      .single()

    if (updateError) {
      // Row update failed after S3 succeeded — clean up the new key.
      try { await deleteObjectsByKeys([s3Key]) }
      catch (cleanupErr) {
        logger.error(
          { err: (cleanupErr as Error).message, s3Key },
          'template_defs_background_cleanup_failed',
        )
      }
      logger.error(
        { err: updateError.message, op: 'template_defs.upload-bg', id },
        'template_defs_background_update_failed',
      )
      throw createError({ statusCode: 500, statusMessage: updateError.message })
    }

    // Clean up the previous background, if any.
    if (existing.background_path && existing.background_path !== s3Key) {
      try { await deleteObjectsByKeys([existing.background_path]) }
      catch (e) {
        logger.warn(
          { err: (e as Error).message, prev: existing.background_path },
          'template_defs_old_background_cleanup_failed',
        )
      }
    }

    return updated
  },
})
