// List active share links for a draft. Used by the share modal so the
// user can see/copy/revoke existing links instead of minting new ones
// every time.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_draft_share_links')
      .select('id, token, expires_at, revoked_at, created_at, created_by')
      .eq('draft_id', id)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) {
      logger.error({ err: error.message, id }, 'share_link_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
