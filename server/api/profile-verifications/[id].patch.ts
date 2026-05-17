// Admin review action: approve or reject a verification request.
//
// RLS gates the UPDATE to admins (`verifications.review` permission).
// Stamps reviewer attribution + decision notes. Notifies the agent
// who submitted the request via the existing notify() helper.
//
// Body:
//   { status: 'approved' | 'rejected', review_notes?: string }
//
// Status 'pending' is NOT accepted via PATCH — only the table's
// default. Once a row has been decided, it stays decided; the agent
// resubmits a new row to retry.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'
import { dispatchWebhook } from '~~/server/utils/webhooks'

const bodySchema = z.object({
  status: z.enum(['approved', 'rejected']),
  review_notes: z.string().trim().max(4000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid verification id' })
    }

    const supabase = await serverSupabaseClient(event)

    const update = {
      status: body.status,
      review_notes: body.review_notes ?? null,
      reviewed_by: user!.id,
      reviewed_at: new Date().toISOString(),
    }

    const { data, error } = await (supabase as any)
      .from('profile_verifications')
      .update(update)
      .eq('id', id)
      // Don't let admins re-decide an already-decided row. Forces a
      // pending → terminal-state transition, never the reverse. Keeps
      // the audit trail unambiguous.
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error(
        { err: error.message, op: 'verifications.review', id },
        'verification_review_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      // Either the row doesn't exist, RLS hid it from this caller, or
      // status was already non-pending. Don't differentiate — leaks
      // less.
      throw createError({
        statusCode: 404,
        statusMessage: 'Verification not found, not pending, or not editable',
      })
    }

    await logActivity({
      event,
      client: supabase,
      action: body.status === 'approved' ? 'verification.approved' : 'verification.rejected',
      entity: 'verification',
      entityId: data.id,
      metadata: {
        profile_id: data.profile_id,
        reviewer_id: user!.id,
        has_review_notes: !!data.review_notes,
      },
    })

    // Notify the agent of the decision. notify() handles email fanout
    // via existing infra (Mailgun + user_notification_preferences).
    try {
      await notify({
        recipientUserId: data.profile_id,
        actorUserId: user!.id,
        kind: body.status === 'approved' ? 'verification.approved' : 'verification.rejected',
        title:
          body.status === 'approved'
            ? 'Your profile is verified'
            : 'Verification request not approved',
        body: data.review_notes,
        href: `/my-profile`,
        metadata: { verification_id: data.id },
      })
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'verifications.review.notify' },
        'verification_notify_failed',
      )
    }

    // Outbound webhook fan-out. Same pattern as inquiries — fire-and-
    // forget with .catch(); never `void <promise>` (see CONTRIBUTING).
    // Payload shape kept minimal + non-PII: partner integrations get
    // the verification id + decision + agent profile id, not the
    // license number / brokerage / evidence URL — those stay server-
    // side. Partners that need richer data fetch via the verifications
    // API.
    const webhookKind =
      body.status === 'approved' ? 'verification.approved' : 'verification.rejected'
    dispatchWebhook(webhookKind, {
      verification_id: data.id,
      profile_id: data.profile_id,
      status: data.status,
      reviewed_by: user!.id,
      reviewed_at: data.reviewed_at,
      has_review_notes: !!data.review_notes,
    }).catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          op: 'verifications.review.webhook_dispatch',
          verification_id: data.id,
        },
        'verification_webhook_dispatch_threw',
      )
    })

    return data
  },
})
