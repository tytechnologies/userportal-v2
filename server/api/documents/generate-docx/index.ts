import { asBlob } from 'html-docx-js-typescript'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { uploadObject, getSignedDownloadUrl, deleteObjectsByKeys } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const documentTypeFromName = (documentName: string): string => {
  if (documentName.includes('Residential Contract of Lease')) return 'residential_contract_of_lease'
  if (documentName.includes('Commercial Contract of Lease')) return 'commercial_contract_of_lease'
  if (documentName.includes('Contract to Sell')) return 'contract_to_sell'
  if (documentName.includes('Authority to Sell')) return 'authority_to_sell'
  if (documentName.includes('Deed of Absolute Sale')) return 'deed_of_absolute_sale'
  if (documentName.includes('Property Management Agreement')) return 'property_management_agreement'
  if (documentName.includes('Letter of Intent') || documentName.includes('LOI')) return 'letter_of_intent'
  return 'other'
}

const directoryFromName = (documentName: string): string => {
  if (documentName.includes('Residential Contract of Lease')) return 'Residential Contract of Lease'
  if (documentName.includes('Commercial Contract of Lease')) return 'Commercial Contract of Lease'
  if (documentName.includes('Contract to Sell')) return 'Contract to Sell'
  if (documentName.includes('Authority to Sell')) return 'Authority to Sell'
  if (documentName.includes('Deed of Absolute Sale')) return 'Deed of Absolute Sale'
  if (documentName.includes('Property Management Agreement')) return 'Property Management Agreement'
  return 'LOI'
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const body = await readBody(event)
    const { htmlTemplate, documentName, metadata = {} } = body || {}

    if (!htmlTemplate || !documentName) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Missing required fields: htmlTemplate or documentName',
      })
    }

    const docxBlob = await asBlob(htmlTemplate as string, {
      orientation: 'portrait',
      margins: { top: 720, right: 720, bottom: 720, left: 720 },
    })

    const directory = directoryFromName(documentName)
    const s3Key = `documents/user-${user.id}/${directory}/${documentName}.docx`
    await uploadObject(s3Key, new Uint8Array(docxBlob as Buffer))

    const fileUrl = await getSignedDownloadUrl(s3Key)

    const supabase = await serverSupabaseClient(event)
    const docMetadata = typeof metadata === 'object' && metadata ? metadata : {}

    // Promoted FK columns (migration 20260502000014). Pull from the
    // metadata payload the form sends — listing_id / contact_id keys
    // by convention. Coerced to numbers when present so PostgREST
    // doesn't reject a stringy "123".
    const rawListingId = (docMetadata as any).listing_id
    const rawContactId = (docMetadata as any).contact_id
    const listingIdFk = rawListingId !== undefined && rawListingId !== null
      ? Number(rawListingId)
      : null
    const contactIdFk = rawContactId !== undefined && rawContactId !== null
      ? Number(rawContactId)
      : null

    const { data: inserted, error: insertError } = await supabase
      .from('documents')
      .insert({
        created_by: user.id,
        document_type: documentTypeFromName(documentName),
        s3_key: s3Key,
        file_name: `${documentName}.docx`,
        file_format: 'docx',
        metadata: docMetadata,
        listing_id: Number.isFinite(listingIdFk as number) ? listingIdFk : null,
        contact_id: Number.isFinite(contactIdFk as number) ? contactIdFk : null,
      })
      .select('id')
      .single()

    if (insertError) {
      // S3 upload succeeded but the metadata insert failed. Without
      // cleanup, the bucket accumulates orphans that nothing references
      // (no row → no delete path → permanent ghost files). Best-effort
      // delete; if THAT also fails we surface the original error and
      // log the leak so it can be reconciled out-of-band.
      try {
        await deleteObjectsByKeys([s3Key])
      } catch (cleanupErr) {
        logger.error(
          { err: (cleanupErr as Error).message, s3Key },
          'document_orphan_cleanup_failed',
        )
      }
      logger.error({ err: insertError.message, s3Key }, 'document_record_failed')
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to save document record. Cleaned up the upload.',
      })
    }

    // Best-effort cross-entity audit. Stamp contact_id + listing_id from
    // the caller's metadata when present so the unified CRM timeline
    // surfaces this in both feeds.
    await logActivity({
      event,
      client: supabase,
      action: 'document.uploaded',
      entity: 'document',
      metadata: {
        document_id: (inserted as any)?.id ?? null,
        document_type: documentTypeFromName(documentName),
        file_name: `${documentName}.docx`,
        contact_id: (docMetadata as any).contact_id ?? null,
        listing_id: (docMetadata as any).listing_id ?? null,
      },
    })

    return {
      success: true,
      fileUrl,
      message: 'Document generated and saved successfully',
    }
  },
})
