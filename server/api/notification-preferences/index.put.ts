// Upsert a notification preference for the caller. Body shape:
//   { kind: string, email_enabled?: boolean, push_enabled?: boolean,
//     sms_enabled?: boolean }
//
// Missing channel fields are not changed (existing row) or default
// (new row). user_id is auto-filled from auth.uid() so clients
// can never write someone else's pref.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  kind: z.string().min(1).max(80),
  email_enabled: z.boolean().optional(),
  push_enabled: z.boolean().optional(),
  sms_enabled: z.boolean().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const supabase = await serverSupabaseClient(event)

    // Build the upsert payload — only columns the caller specified, plus
    // the always-set keys.
    const row: Record<string, unknown> = {
      user_id: user!.id,
      kind: body.kind,
    }
    if (body.email_enabled !== undefined) row.email_enabled = body.email_enabled
    if (body.push_enabled !== undefined)  row.push_enabled  = body.push_enabled
    if (body.sms_enabled !== undefined)   row.sms_enabled   = body.sms_enabled

    const { data, error } = await (supabase as any)
      .from('user_notification_preferences')
      .upsert(row, { onConflict: 'user_id,kind' })
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'unp.upsert' }, 'unp_upsert_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },
})
