// Mint a signed download URL for an imported draft's S3 object.
// RLS gates whether the caller can see the row at all; if they can,
// they can fetch a short-lived signed URL.
//
// Returns:
//   { url: string }                   on success
//   404 if the row is missing or hidden by RLS
//   400 if the row has no storage_path (it's a form draft, not import)

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedDownloadUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_drafts')
      .select('id, storage_path, storage_mime')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'document_drafts.signedUrl', id }, 'document_draft_url_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })
    if (!data.storage_path) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Draft has no imported file (it is a form draft).',
      })
    }

    // 5-minute window — long enough for a slow PDF render, short enough
    // that a leaked URL stops being useful quickly.
    const url = await getSignedDownloadUrl(data.storage_path, 300)
    return { url, mime: data.storage_mime ?? null }
  },
})
