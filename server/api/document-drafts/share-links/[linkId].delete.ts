// Revoke (soft-delete) a share link. We set revoked_at instead of
// hard-deleting so audit trails stay intact and reusing a leaked
// token after revocation gives a clean 410 from the public viewer.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const linkId = getRouterParam(event, 'linkId')
    if (!linkId) throw createError({ statusCode: 400, statusMessage: 'Missing link id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_draft_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', linkId)
      .select('id, revoked_at')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, linkId }, 'share_link_revoke_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Share link not found or not revocable' })
    return data
  },
})
