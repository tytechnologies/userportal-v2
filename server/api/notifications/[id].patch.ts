// Mark a notification read or dismissed. RLS permits the recipient
// (or users.manage admins).
//
// Body shape:
//   { read?: boolean, dismissed?: boolean }
//
// `read=true` stamps read_at = now (no-op if already set).
// `read=false` clears read_at.
// Same for dismissed.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  read: z.boolean().optional(),
  dismissed: z.boolean().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid notification id' })
    }

    const update: Record<string, unknown> = {}
    if (body.read === true)  update.read_at = new Date().toISOString()
    if (body.read === false) update.read_at = null
    if (body.dismissed === true)  update.dismissed_at = new Date().toISOString()
    if (body.dismissed === false) update.dismissed_at = null

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('notifications')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'notifications.update', id }, 'notifications_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Notification not found' })
    return data
  },
})
