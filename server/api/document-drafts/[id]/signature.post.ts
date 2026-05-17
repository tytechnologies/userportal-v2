// Save a signature image for a draft. The client renders an HTML5
// canvas, exports as PNG data URL, and POSTs it here. The server
// stores the PNG in S3 under a stable per-field key and returns the
// signed URL for the editor to embed in formData.
//
// We intentionally do NOT inline base64-encoded PNGs in
// document_drafts.data — sigs are 50–500 KB each and JSONB rows that
// large slow every other read of the row.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import {
  uploadObject,
  deleteObjectsByKeys,
  getSignedDownloadUrl,
} from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  /** Snake_case key matching the template's signature field. */
  field_key: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/),
  /** PNG data URL ("data:image/png;base64,..."). */
  data_url: z
    .string()
    .min(64)
    .max(20_000_000) // ~14 MB raw — generous; canvases are usually < 200 KB.
    .regex(/^data:image\/png;base64,/, 'must be a PNG data URL'),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)

    // Confirm draft exists + caller can write to it. RLS on the
    // subsequent row update would catch this, but failing early gives
    // the user a cleaner error than a 500 on a stuck S3 upload.
    const { data: row, error: fetchError } = await (supabase as any)
      .from('document_drafts')
      .select('id, owner_user_id')
      .eq('id', id)
      .maybeSingle()
    if (fetchError) {
      throw createError({ statusCode: 500, statusMessage: fetchError.message })
    }
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })

    // Decode the PNG payload. Strip the data-url prefix; the regex
    // above already validated shape.
    const base64 = body.data_url.split(',', 2)[1] ?? ''
    let buffer: Buffer
    try { buffer = Buffer.from(base64, 'base64') }
    catch { throw createError({ statusCode: 400, statusMessage: 'Invalid signature payload' }) }
    if (buffer.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Empty signature' })
    }

    const userPart = user?.id ?? 'anon'
    // One key per field — overwriting previous sigs is fine (the row's
    // pointer still points at the same key, and we re-sign URLs every
    // load anyway). Cache-buster timestamp ensures the editor doesn't
    // serve a stale cached sig after re-signing.
    const s3Key = `document-drafts/${userPart}/${id}/signatures/${body.field_key}-${Date.now()}.png`

    try { await uploadObject(s3Key, buffer) }
    catch (e: any) {
      logger.error({ err: e?.message, id, s3Key }, 'document_draft_signature_upload_failed')
      throw createError({ statusCode: 500, statusMessage: 'Signature upload failed.' })
    }

    // Pull the previous signature URL/path for cleanup.
    const { data: existing } = await (supabase as any)
      .from('document_drafts')
      .select('data')
      .eq('id', id)
      .maybeSingle()

    const prevSignaturePath: string | null =
      existing?.data?._signatures?.[body.field_key]?.path ?? null

    // Update the row's data jsonb with the field's PNG pointer. Stored
    // under `_signatures.<field_key>.{path,uploaded_at}` to keep the
    // user-visible JSONB clean; the editor reads back via the signed
    // URL on load.
    const newData: Record<string, any> = {
      ...(existing?.data ?? {}),
    }
    if (!newData._signatures) newData._signatures = {}
    newData._signatures[body.field_key] = {
      path: s3Key,
      uploaded_at: new Date().toISOString(),
    }

    const { data: updated, error: updateError } = await (supabase as any)
      .from('document_drafts')
      .update({ data: newData })
      .eq('id', id)
      .select('id, data')
      .single()

    if (updateError) {
      // Roll back the upload so we don't leave an orphan PNG.
      try { await deleteObjectsByKeys([s3Key]) }
      catch (cleanupErr) {
        logger.warn(
          { err: (cleanupErr as Error).message, s3Key },
          'document_draft_signature_cleanup_failed',
        )
      }
      throw createError({ statusCode: 500, statusMessage: updateError.message })
    }

    // Best-effort cleanup of the previous PNG.
    if (prevSignaturePath && prevSignaturePath !== s3Key) {
      try { await deleteObjectsByKeys([prevSignaturePath]) } catch { /* ok */ }
    }

    const url = await getSignedDownloadUrl(s3Key, 3600)
    return { url, path: s3Key, field_key: body.field_key }
  },
})
