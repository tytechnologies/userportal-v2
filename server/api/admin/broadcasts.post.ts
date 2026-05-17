// Admin broadcast / announcement.
//
// POST /api/admin/broadcasts
//
// Admin-only. Fans out a single announcement as in-app notifications
// (and email per recipient prefs) to a chosen audience: all users,
// admins, managers, agents, or a single team.
//
// Each recipient gets a row in `notifications` via the existing
// notify() helper, which:
//   - skips when actor === recipient (admin doesn't get their own)
//   - respects user_notification_preferences for email fanout
//   - is fire-and-forget (per-row failures logged, never block)
//
// Audit: a single `broadcast.sent` activity event with the audience
// + recipient count in metadata.

import { z } from 'zod'
import { serverSupabaseUser } from '../../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(10_000).nullable().optional(),
  href: z.string().trim().max(2048).nullable().optional(),
  audience: z.enum(['all', 'admins', 'managers', 'agents']).default('all'),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const sender = await serverSupabaseUser(event)
    const senderId = sender?.id ?? null
    const admin = getServerSupabaseAdmin()

    // 1. Resolve the audience to a list of recipient ids.
    let recipientQuery: any = (admin as any).from('profiles').select('id')
    if (body.audience !== 'all') {
      const role =
        body.audience === 'admins'
          ? 'admin'
          : body.audience === 'managers'
            ? 'manager'
            : 'agent'
      recipientQuery = recipientQuery.eq('role', role)
    }
    const { data: recipients, error: recipientsErr } = await recipientQuery
    if (recipientsErr) {
      logger.error(
        { err: recipientsErr.message, op: 'admin.broadcasts.recipients' },
        'broadcast_recipients_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not resolve audience',
      })
    }

    const ids = ((recipients ?? []) as Array<{ id: string }>).map((r) => r.id)

    // 2. Fan out. notify() handles email + in-app, respects prefs,
    //    skips self. Per-row failures collected for the response.
    const errors: Array<{ recipient_user_id: string; reason: string }> = []
    let sent = 0
    for (const recipientUserId of ids) {
      try {
        await notify({
          recipientUserId,
          actorUserId: senderId,
          kind: 'broadcast.announcement',
          title: body.title,
          body: body.body ?? null,
          href: body.href ?? null,
          metadata: { audience: body.audience },
        })
        sent++
      } catch (err: any) {
        errors.push({
          recipient_user_id: recipientUserId,
          reason: err?.message || String(err),
        })
      }
    }

    // 3. Audit. Single summary event â€” N per-row notifications would
    //    be too noisy for the activity timeline.
    await logActivity({
      event,
      action: 'broadcast.sent',
      // Audit entity for broadcasts isn't in the named union; it's
      // open-ended via (string & {}) â€” cast for clarity.
      entity: 'broadcast' as any,
      metadata: {
        audience: body.audience,
        recipients: ids.length,
        sent,
        errors: errors.length,
        title: body.title,
      },
    })

    return {
      audience: body.audience,
      recipients: ids.length,
      sent,
      errors,
    }
  },
})
