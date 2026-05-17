// Bulk mark every unread notification for the caller as read. Cheap UX
// for the bell-icon "mark all read" affordance.
//
// RLS limits the update to recipient_user_id = auth.uid() (or
// users.manage admins, who could mark someone else's — that's fine,
// they're admins).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const supabase = await serverSupabaseClient(event)
    const nowIso = new Date().toISOString()

    const { error, count } = await (supabase as any)
      .from('notifications')
      .update({ read_at: nowIso }, { count: 'exact' })
      .eq('recipient_user_id', user!.id)
      .is('read_at', null)

    if (error) {
      logger.error({ err: error.message, op: 'notifications.mark_all_read' }, 'notifications_mark_all_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { success: true, updated: count ?? 0 }
  },
})
