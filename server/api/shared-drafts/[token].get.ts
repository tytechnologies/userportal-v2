// Public token-keyed read of a draft. NO auth required — possession of
// a valid, unrevoked, unexpired token is the access credential. RLS
// would block this read for anonymous callers, so we use the SERVICE-
// ROLE client (the only place in this repo that does so on a public
// endpoint) and validate the token ourselves before returning data.
//
// Security model:
//   - 32-byte cryptographically-random tokens. Brute-forcing one valid
//     token from a corpus of N is N / 2^256 — negligible.
//   - Token rows are ONLY discoverable via this endpoint OR via an
//     authenticated user with access to the parent draft (RLS). The
//     listing endpoint requires auth.
//   - The endpoint NEVER returns the token alongside the draft (we
//     return the draft fields plus an opaque expires_at), so a
//     compromised page can't be used to enumerate other tokens.
//   - Revocation: revoked_at + expiration are checked here.
//   - Returns ONLY the draft's user-facing data — NOT owner_user_id,
//     not contact_id (PII), not internal _signatures storage paths.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { getSignedDownloadUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!token || token.length < 16) {
    throw createError({ statusCode: 400, statusMessage: 'Missing or malformed token' })
  }

  // Service-role client — bypasses RLS so the unauthenticated request
  // can resolve the share row. Only used on this single endpoint.
  const supabase = getServerSupabaseAdmin() as any

  const { data: link, error: linkError } = await supabase
    .from('document_draft_share_links')
    .select('id, draft_id, token, expires_at, revoked_at')
    .eq('token', token)
    .maybeSingle()

  if (linkError) {
    logger.error({ err: linkError.message, token: token.slice(0, 6) + '…' }, 'shared_draft_link_lookup_failed')
    throw createError({ statusCode: 500, statusMessage: 'Failed to validate link' })
  }
  if (!link) {
    throw createError({ statusCode: 404, statusMessage: 'Link not found' })
  }
  if (link.revoked_at) {
    throw createError({ statusCode: 410, statusMessage: 'Link revoked' })
  }
  if (new Date(link.expires_at).getTime() < Date.now()) {
    throw createError({ statusCode: 410, statusMessage: 'Link expired' })
  }

  const { data: draft, error: draftError } = await supabase
    .from('document_drafts')
    .select('id, template_id, title, data, status, storage_path, storage_mime, storage_size_bytes, updated_at')
    .eq('id', link.draft_id)
    .maybeSingle()

  if (draftError) {
    logger.error({ err: draftError.message, draftId: link.draft_id }, 'shared_draft_load_failed')
    throw createError({ statusCode: 500, statusMessage: 'Failed to load draft' })
  }
  if (!draft) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })

  // Strip internal storage paths from `data._signatures` and replace
  // them with short-lived signed URLs the public viewer can render.
  const sanitizedData: Record<string, any> = { ...(draft.data ?? {}) }
  if (sanitizedData._signatures && typeof sanitizedData._signatures === 'object') {
    const out: Record<string, { url: string }> = {}
    for (const [key, val] of Object.entries(sanitizedData._signatures as Record<string, any>)) {
      const path = val?.path
      if (typeof path === 'string') {
        try {
          out[key] = { url: await getSignedDownloadUrl(path, 600) }
        } catch (e) {
          logger.warn({ err: (e as Error).message, key, path }, 'shared_signature_sign_failed')
        }
      }
    }
    sanitizedData._signatures = out
  }

  // For storage-backed (imported) drafts, mint a signed URL too — but
  // expose only the URL, never the raw S3 key.
  let storage_url: string | null = null
  if (draft.storage_path) {
    try {
      storage_url = await getSignedDownloadUrl(draft.storage_path, 600)
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'shared_draft_storage_sign_failed')
    }
  }

  return {
    id: draft.id,
    template_id: draft.template_id,
    title: draft.title,
    data: sanitizedData,
    status: draft.status,
    storage_mime: draft.storage_mime,
    storage_size_bytes: draft.storage_size_bytes,
    storage_url,
    updated_at: draft.updated_at,
    expires_at: link.expires_at,
  }
})
