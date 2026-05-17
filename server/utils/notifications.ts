// Server-side notification fanout helper.
//
// The `notifications` table has no INSERT policy for `authenticated`
// (intentional — we don't want clients minting notifications for other
// users). Server endpoints that need to notify someone bypass RLS via
// the service-role client.
//
// All inserts are best-effort: a failed notification should never fail
// the user-visible action. Errors are logged and swallowed.

import { getServerSupabaseAdmin } from './supabase'
import { logger } from './logger'
import { renderEmail, sendEmail } from './email'

export type NotifyInput = {
  recipientUserId: string
  /** Dotted entity.verb identifier — mirrors activities.action. */
  kind: string
  title: string
  body?: string | null
  href?: string | null
  actorUserId?: string | null
  contactId?: number | null
  listingId?: number | null
  metadata?: Record<string, unknown>
}

/**
 * Insert one notification row. Skips silently if the recipient is the
 * actor (don't notify yourself about your own action).
 */
export async function notify(input: NotifyInput): Promise<void> {
  if (input.actorUserId && input.actorUserId === input.recipientUserId) return

  let admin: ReturnType<typeof getServerSupabaseAdmin> | null = null
  try {
    admin = getServerSupabaseAdmin()
    const { error } = await (admin as any)
      .from('notifications')
      .insert({
        recipient_user_id: input.recipientUserId,
        actor_user_id: input.actorUserId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
        contact_id: input.contactId ?? null,
        listing_id: input.listingId ?? null,
        metadata: input.metadata ?? {},
      })
    if (error) {
      logger.warn(
        { err: error.message, kind: input.kind, recipient: input.recipientUserId },
        'notification_insert_failed',
      )
    }
  } catch (err: any) {
    // Don't propagate; the caller's user-visible action already
    // succeeded by the time we're here.
    logger.warn({ err: err?.message, kind: input.kind }, 'notification_insert_threw')
    return
  }

  // Fan out to email if the recipient has it enabled. Never blocks —
  // the in-app notification has already landed.
  fanoutEmail(admin, input).catch((err) => {
    logger.warn({ err: err?.message, kind: input.kind }, 'notification_email_fanout_failed')
  })
}

async function fanoutEmail(
  admin: ReturnType<typeof getServerSupabaseAdmin> | null,
  input: NotifyInput,
): Promise<void> {
  if (!admin) return

  // Kill switch — EMAIL_DELIVERY_DISABLED=1 short-circuits the
  // sendEmail fan-out below. The helper itself is currently a
  // no-op (no provider wired) but the kill switch stays so
  // re-enabling email is one provider drop-in away.
  // In-app notifications keep landing in the bell unchanged.
  const emailDisabled =
    String(process.env.EMAIL_DELIVERY_DISABLED ?? '')
      .toLowerCase()
      .match(/^(1|true|yes)$/)
  if (emailDisabled) {
    logger.debug({ kind: input.kind, op: 'notifications.email.disabled' }, 'email_delivery_disabled')
    return
  }

  // Look up recipient email + actor name + preference in parallel.
  // All three reads use service-role so RLS doesn't hide the rows.
  const [profileRes, prefRes, actorRes] = await Promise.all([
    (admin as any)
      .from('profiles')
      .select('email, full_name')
      .eq('id', input.recipientUserId)
      .maybeSingle(),
    (admin as any)
      .from('user_notification_preferences')
      .select('email_enabled')
      .eq('user_id', input.recipientUserId)
      .eq('kind', input.kind)
      .maybeSingle(),
    input.actorUserId
      ? (admin as any)
          .from('profiles')
          .select('full_name')
          .eq('id', input.actorUserId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const email: string | null = profileRes?.data?.email ?? null
  if (!email) return

  // Default opt-in: missing pref row = email_enabled true. Explicit
  // false from the table opts out.
  const enabled = prefRes?.data ? Boolean(prefRes.data.email_enabled) : true
  if (!enabled) return

  const baseUrl = process.env.PUBLIC_APP_URL || ''
  const hrefAbsolute = input.href
    ? (input.href.startsWith('http') ? input.href : `${baseUrl}${input.href}`)
    : null

  const tpl = renderEmail(input.kind, {
    recipientName: profileRes?.data?.full_name ?? null,
    actorName: actorRes?.data?.full_name ?? null,
    title: input.title,
    body: input.body ?? null,
    hrefAbsolute,
  })

  await sendEmail({ to: email, subject: tpl.subject, html: tpl.html })
}
