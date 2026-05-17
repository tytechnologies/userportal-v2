// Re-sign the URL for a draft's finalized notarized PDF.
//
// GET /api/document-drafts/:id/finalized-url
// Returns: { url, path, expires_in_seconds }
//
// Companion to upload-signed.post.ts — the upload returns a fresh
// URL on the success response, but that URL expires in ~1 hour.
// When the broker comes back hours/days later and clicks "View" on
// the on-file PDF, this endpoint mints a new signed URL pointing at
// the same S3 path.
//
// Auth: required + agent+. RLS on document_drafts already restricts
// who can read the row; we surface only what the row already permits.
// Returns 404 when the draft has no finalized document.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedDownloadUrl } from '~~/server/utils/s3'
import { requireRole } from '~~/server/utils/rbac'

const SIGNED_URL_TTL_SECONDS = 3600

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'agent')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Missing or invalid draft id' })
    }

    const supabase = await serverSupabaseClient(event)

    const { data: row, error } = await (supabase as any)
      .from('document_drafts')
      .select('id, data')
      .eq('id', id)
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })

    const path: string | undefined = row.data?._finalized_document?.path
    if (!path) {
      throw createError({
        statusCode: 404,
        statusMessage: 'No notarized PDF uploaded for this draft yet',
      })
    }

    const url = await getSignedDownloadUrl(path, SIGNED_URL_TTL_SECONDS)
    return {
      url,
      path,
      expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    }
  },
})
