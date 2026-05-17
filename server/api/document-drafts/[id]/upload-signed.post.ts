// Upload the final, notarized / tax-stamped PDF for a document draft.
//
// POST /api/document-drafts/:id/upload-signed
// Body:
//   {
//     data_url: string,       // "data:application/pdf;base64,..." — PDF only
//     filename?: string,      // original filename for the audit trail
//     transition_to_signed?: boolean   // default true — flip status to 'signed'
//   }
//
// Why this exists: the existing signature.post.ts handles in-app PNG
// signatures (canvas → S3). It does NOT handle the broker workflow
// where the draft is printed, taken to a notary, signed + tax-stamped
// offline, then scanned back as a PDF for the system of record.
// That uploaded PDF lives at draft.data._finalized_document.{path,
// uploaded_at, original_filename} — a JSONB pointer pattern the row
// already uses for inline signatures, so no schema migration.
//
// Side effects:
//   1. Stores the PDF in S3 at
//      document-drafts/<user>/<draft>/finalized/<ts>.pdf.
//      Per-draft sub-folder makes batch deletion easy on row delete.
//   2. Removes any prior finalized PDF for this draft (orphan cleanup).
//   3. Updates draft.data._finalized_document with the new pointer.
//   4. Auto-transitions status: draft|in_review → signed (unless the
//      caller passes transition_to_signed=false). 'signed' or
//      'archived' is preserved as-is.
//   5. Audits via the activities table.
//
// Auth: required + agent+ role gate (defense-in-depth on RLS).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import {
  uploadObject,
  deleteObjectsByKeys,
  getSignedDownloadUrl,
} from '~~/server/utils/s3'
import { logActivity } from '~~/server/utils/audit'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

// ~33 MB base64 → ~25 MB raw PDF — covers most notarized scans
// without leaving the door open for casual abuse.
const MAX_DATA_URL_LEN = 33_000_000

const bodySchema = z.object({
  data_url: z
    .string()
    .min(64)
    .max(MAX_DATA_URL_LEN)
    .regex(/^data:application\/pdf;base64,/, 'must be a base64 application/pdf data URL'),
  filename: z.string().trim().min(1).max(200).optional(),
  transition_to_signed: z.boolean().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    await requireRole(event, 'agent')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Missing or invalid draft id' })
    }
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const supabase = await serverSupabaseClient(event)

    // RLS-gated existence check + grab prior pointer for cleanup.
    const { data: row, error: fetchError } = await (supabase as any)
      .from('document_drafts')
      .select('id, status, data, owner_user_id, listing_id, contact_id')
      .eq('id', id)
      .maybeSingle()
    if (fetchError) {
      throw createError({ statusCode: 500, statusMessage: fetchError.message })
    }
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })

    // Decode the PDF.
    const base64 = body.data_url.split(',', 2)[1] ?? ''
    let buffer: Buffer
    try { buffer = Buffer.from(base64, 'base64') }
    catch { throw createError({ statusCode: 400, statusMessage: 'Invalid PDF payload' }) }
    if (buffer.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Empty PDF' })
    }
    // Sanity-check the magic bytes — first 4 bytes of every PDF are %PDF.
    if (
      buffer.length < 5 ||
      buffer[0] !== 0x25 || // %
      buffer[1] !== 0x50 || // P
      buffer[2] !== 0x44 || // D
      buffer[3] !== 0x46    // F
    ) {
      throw createError({ statusCode: 400, statusMessage: 'Not a valid PDF (missing %PDF header)' })
    }

    // Per-draft sub-folder + timestamp filename. Cache-buster timestamp
    // means a re-upload doesn't collide with the prior path even if
    // the JSONB pointer briefly references the old one mid-flight.
    const s3Key = `document-drafts/${user.id}/${id}/finalized/${Date.now()}.pdf`

    try { await uploadObject(s3Key, buffer) }
    catch (e: any) {
      logger.error(
        { err: e?.message, id, s3Key },
        'document_draft_signed_upload_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Upload failed.' })
    }

    const prevPath: string | null = row.data?._finalized_document?.path ?? null

    // Update the row's data jsonb with the finalized-document pointer
    // + decide on status transition. Pre-2026-05-09 callers won't have
    // `_finalized_document` at all; we initialize it here.
    const newData: Record<string, any> = { ...(row.data ?? {}) }
    newData._finalized_document = {
      path: s3Key,
      uploaded_at: new Date().toISOString(),
      original_filename: body.filename ?? null,
      byte_length: buffer.length,
    }

    // Status transition: draft|in_review → signed by default. The
    // caller can opt out via transition_to_signed=false (e.g. when
    // re-uploading a corrected scan and the workflow shouldn't
    // re-trigger downstream side-effects).
    const shouldTransition = body.transition_to_signed !== false
    const transitionable = ['draft', 'in_review'].includes(row.status)
    const newStatus =
      shouldTransition && transitionable ? 'signed' : row.status

    const updates: Record<string, unknown> = { data: newData }
    if (newStatus !== row.status) updates.status = newStatus

    const { data: updated, error: updateError } = await (supabase as any)
      .from('document_drafts')
      .update(updates)
      .eq('id', id)
      .select('id, data, status')
      .single()

    if (updateError) {
      // Roll back the S3 upload — don't leave an orphan PDF on a
      // failed row write.
      try { await deleteObjectsByKeys([s3Key]) }
      catch (cleanupErr) {
        logger.warn(
          { err: (cleanupErr as Error).message, s3Key },
          'document_draft_signed_cleanup_failed',
        )
      }
      throw createError({ statusCode: 500, statusMessage: updateError.message })
    }

    // Best-effort cleanup of the previous finalized PDF (the row's
    // pointer no longer references it).
    if (prevPath && prevPath !== s3Key) {
      try { await deleteObjectsByKeys([prevPath]) } catch { /* ok */ }
    }

    await logActivity({
      event,
      // The audit catalog has a 'document' entity; document_draft.* actions
      // ride on it (matches the convention from index.post.ts +
      // transition.post.ts in this directory).
      action: (
        newStatus !== row.status
          ? 'document_draft.signed_uploaded_and_finalized'
          : 'document_draft.signed_uploaded'
      ) as any,
      entity: 'document',
      metadata: {
        draft_id: id,
        listing_id: row.listing_id ?? null,
        contact_id: row.contact_id ?? null,
        prior_status: row.status,
        new_status: newStatus,
        prior_path: prevPath,
        new_path: s3Key,
        original_filename: body.filename ?? null,
        byte_length: buffer.length,
      },
    })

    const url = await getSignedDownloadUrl(s3Key, 3600)
    return {
      url,
      path: s3Key,
      original_filename: body.filename ?? null,
      byte_length: buffer.length,
      status: updated.status,
      transitioned: newStatus !== row.status,
    }
  },
})
