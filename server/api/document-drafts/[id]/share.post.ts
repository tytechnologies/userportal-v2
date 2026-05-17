// Mint a token-based read-only share link for a draft.
//
// Token: 32 cryptographically-random bytes, base64url-encoded → 43
// characters. Brute-forcing a valid token is impractical; the public
// /api/shared-drafts/[token] endpoint will only return the draft if
// the token row exists, isn't revoked, and isn't expired.
//
// Body:
//   { expires_in_days?: number }   default 7
//
// Returns:
//   { token, expires_at, share_url }

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { randomBytes } from 'node:crypto'

const bodySchema = z.object({
  expires_in_days: z.number().int().min(1).max(365).default(7),
})

function mintToken(): string {
  // base64url alphabet so the token is URL-safe.
  return randomBytes(32).toString('base64url')
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)

    // Confirm we can read the draft (and therefore can share it).
    const { data: draft, error: fetchError } = await (supabase as any)
      .from('document_drafts')
      .select('id, owner_user_id')
      .eq('id', id)
      .maybeSingle()
    if (fetchError) throw createError({ statusCode: 500, statusMessage: fetchError.message })
    if (!draft) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })

    const token = mintToken()
    const days = body.expires_in_days ?? 7
    const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

    const { data: link, error: insertError } = await (supabase as any)
      .from('document_draft_share_links')
      .insert({
        draft_id: id,
        token,
        expires_at,
        created_by: user?.id ?? null,
      })
      .select('id, token, expires_at, created_at')
      .single()

    if (insertError) {
      logger.error({ err: insertError.message, id }, 'share_link_create_failed')
      throw createError({ statusCode: 500, statusMessage: insertError.message })
    }

    // Compose the public share URL based on the request origin so it
    // works in dev, staging, and prod without a separate config.
    const origin =
      getRequestHeader(event, 'origin') ||
      getRequestHeader(event, 'x-forwarded-host')
        ? `https://${getRequestHeader(event, 'x-forwarded-host')}`
        : ''
    const share_url = origin
      ? `${origin}/shared/document-drafts/${link.token}`
      : `/shared/document-drafts/${link.token}`

    setResponseStatus(event, 201)
    return { ...link, share_url }
  },
})
