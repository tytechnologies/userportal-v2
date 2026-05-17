// POST /api/documents/upload
// Multipart upload: { file, deal_id?, contact_id?, listing_id?, document_type }
// Returns: { id: string } — the new documents.id
//
// Generic counterpart to upload-viewing-list-pdf.post.ts. Used by the
// post-signing workflow step row to attach evidence to the workflow,
// but type-agnostic so other features can adopt it. RLS on `documents`
// gates the insert: when deal_id is set the deals-pipeline policies
// require deal_can_write(deal_id); otherwise the legacy owner policy
// applies.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { uploadObject, deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const ALLOWED_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx'])

function extOf(name: string | undefined): string {
  const m = (name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const parts = await readMultipartFormData(event)
    if (!parts || parts.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No multipart payload' })
    }

    let file: { name?: string; filename?: string; type?: string; data: Buffer } | null = null
    const fields: Record<string, string> = {}
    for (const p of parts) {
      if (p.name === 'file' && p.data) {
        file = { name: p.name, filename: p.filename, type: p.type, data: p.data as Buffer }
      } else if (p.name && !p.filename && p.data) {
        fields[p.name] = p.data.toString('utf8')
      }
    }

    if (!file || !file.data || file.data.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Missing file part' })
    }

    const documentType = (fields.document_type || '').trim()
    if (!documentType) {
      throw createError({ statusCode: 400, statusMessage: 'document_type is required' })
    }

    const dealId = fields.deal_id || null
    const listingIdRaw = fields.listing_id
    const contactIdRaw = fields.contact_id
    const listingId = listingIdRaw ? Number(listingIdRaw) : null
    const contactId = contactIdRaw ? Number(contactIdRaw) : null

    const originalName = file.filename || `upload-${Date.now()}`
    const ext = extOf(originalName) || 'bin'
    if (!ALLOWED_FORMATS.has(ext)) {
      throw createError({ statusCode: 415, statusMessage: `Unsupported file format: .${ext}` })
    }

    // S3 key scoping: deal-bound uploads land under /deals/<id>/; otherwise
    // a per-user prefix keeps things readable in the bucket.
    const stamp = Date.now()
    const safeBase = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
    const s3Key = dealId
      ? `documents/deals/${dealId}/${stamp}-${safeBase}`
      : `documents/users/${user.id}/${stamp}-${safeBase}`

    await uploadObject(s3Key, file.data)

    const supabase = await serverSupabaseClient(event)
    const fileFormat = ALLOWED_FORMATS.has(ext) ? ext : 'pdf'
    const { data: inserted, error: insertError } = await (supabase as any)
      .from('documents')
      .insert({
        created_by: user.id,
        document_type: documentType,
        s3_key: s3Key,
        file_name: originalName,
        file_format: fileFormat,
        deal_id: dealId,
        contact_id: contactId,
        listing_id: listingId,
        metadata: {},
      })
      .select('id')
      .single()

    if (insertError) {
      try {
        await deleteObjectsByKeys([s3Key])
      } catch (cleanupErr) {
        logger.error(
          { err: (cleanupErr as Error).message, s3Key },
          'documents_upload_orphan_cleanup_failed',
        )
      }
      logger.error({ err: insertError.message, s3Key, documentType }, 'documents_upload_insert_failed')
      throw createError({
        statusCode: 500,
        statusMessage: insertError.message || 'Failed to save document record.',
      })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'document.uploaded',
      entity: 'document',
      metadata: {
        document_id: (inserted as any)?.id ?? null,
        document_type: documentType,
        file_name: originalName,
        deal_id: dealId,
        listing_id: listingId,
        contact_id: contactId,
      },
    })

    return { id: (inserted as any).id as string }
  },
})
