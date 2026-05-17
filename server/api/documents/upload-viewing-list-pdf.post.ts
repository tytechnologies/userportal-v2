import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { uploadObject, getSignedDownloadUrl, deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const body = await readBody(event)
    const { pdfBase64, clientName, contactId, listingId } = body || {}

    if (!pdfBase64 || !clientName) {
      throw createError({ statusCode: 400, statusMessage: 'Missing pdfBase64 or clientName' })
    }

    const dateStr = new Date().toISOString().split('T')[0]
    const fileName = `Viewing List for Client - ${clientName} - ${dateStr}.pdf`
    const s3Key = `documents/Viewing Lists/${fileName}`

    const buffer = Buffer.from(pdfBase64, 'base64')
    await uploadObject(s3Key, buffer)

    const supabase = await serverSupabaseClient(event)
    const docMetadata: Record<string, unknown> = {
      client_name: clientName,
      viewing_date: dateStr,
    }
    // Optional cross-entity links — caller can pass contactId / listingId
    // to wire this row into the unified CRM timeline.
    if (contactId !== undefined && contactId !== null) docMetadata.contact_id = contactId
    if (listingId !== undefined && listingId !== null) docMetadata.listing_id = listingId

    const { data: inserted, error: insertError } = await supabase
      .from('documents')
      .insert({
        created_by: user.id,
        document_type: 'viewing_list',
        s3_key: s3Key,
        file_name: fileName,
        file_format: 'pdf',
        metadata: docMetadata,
        // Promoted FK columns (migration 20260502000014). The metadata
        // entries above stay populated for backwards compat with code
        // that still reads them.
        contact_id: contactId ?? null,
        listing_id: listingId ?? null,
      })
      .select('id')
      .single()

    if (insertError) {
      // S3 succeeded, DB failed → clean up the orphan rather than leaving
      // a referenceless file in the bucket forever.
      try {
        await deleteObjectsByKeys([s3Key])
      } catch (cleanupErr) {
        logger.error(
          { err: (cleanupErr as Error).message, s3Key },
          'viewing_list_orphan_cleanup_failed',
        )
      }
      logger.error({ err: insertError.message, s3Key }, 'viewing_list_record_failed')
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to save viewing list record. Cleaned up the upload.',
      })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'document.uploaded',
      entity: 'document',
      metadata: {
        document_id: (inserted as any)?.id ?? null,
        document_type: 'viewing_list',
        file_name: fileName,
        client_name: clientName,
        contact_id: docMetadata.contact_id ?? null,
        listing_id: docMetadata.listing_id ?? null,
      },
    })

    return { url: await getSignedDownloadUrl(s3Key) }
  },
})
