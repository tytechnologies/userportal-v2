// List the caller's notification preferences. RLS scopes to the
// caller's own rows. Missing rows = defaults (email_enabled=true) —
// the client merges client-side instead of us synthesizing rows here.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('user_notification_preferences')
      .select('*')

    if (error) {
      logger.error({ err: error.message, op: 'unp.list' }, 'unp_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
