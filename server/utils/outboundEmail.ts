// Outbound email queue helper.
//
// Use for EXTERNAL recipients (envelope signers, broker invitees,
// platform-fee invoice notices to agent emails). Internal portal
// users continue to use notifications.ts → notify(); that path
// already covers the in-app bell + email fan-out.
//
// Idempotency: pass `dedupeKey` so re-running an enqueue (e.g., on
// envelope_send retry) doesn't double-send. UNIQUE index on the
// outbound_emails.dedupe_key column makes the INSERT a no-op when
// the same key already exists.

import { getServerSupabaseAdmin } from './supabase'
import { logger } from './logger'

export type EnqueueOutboundEmailInput = {
  to: string
  toName?: string | null
  recipientUserId?: string | null
  templateKind: string
  subject: string
  /** Inputs passed through to renderEmail at send time. */
  templateInput: {
    recipientName?: string | null
    actorName?: string | null
    title: string
    body?: string | null
    hrefAbsolute?: string | null
    [key: string]: unknown
  }
  /** Idempotent enqueue — same key won't duplicate. */
  dedupeKey?: string
  referenceKind?: string
  referenceId?: string | null
  /** Default 3. Per-row override for high-stakes sends (legal docs). */
  maxAttempts?: number
  /** Defer delivery; default = now. */
  scheduledAt?: string
  metadata?: Record<string, unknown>
  createdBy?: string | null
}

export async function enqueueOutboundEmail(
  input: EnqueueOutboundEmailInput,
): Promise<{ ok: boolean; id?: string; deduped?: boolean }> {
  const admin = getServerSupabaseAdmin()

  try {
    const { data, error } = await (admin as any)
      .from('outbound_emails')
      .insert({
        to_email: input.to.trim(),
        to_name: input.toName ?? null,
        recipient_user_id: input.recipientUserId ?? null,
        template_kind: input.templateKind,
        subject: input.subject,
        template_input: input.templateInput,
        max_attempts: input.maxAttempts ?? 3,
        scheduled_at: input.scheduledAt ?? new Date().toISOString(),
        reference_kind: input.referenceKind ?? null,
        reference_id: input.referenceId ?? null,
        dedupe_key: input.dedupeKey ?? null,
        metadata: input.metadata ?? {},
        created_by: input.createdBy ?? null,
      })
      .select('id')
      .single()

    if (error) {
      // 23505 unique_violation on dedupe_key = idempotent re-enqueue. Not a failure.
      if ((error as any).code === '23505') {
        return { ok: true, deduped: true }
      }
      logger.warn(
        { err: error.message, op: 'enqueueOutboundEmail', kind: input.templateKind, to: input.to },
        'outbound_email_enqueue_failed',
      )
      return { ok: false }
    }

    return { ok: true, id: data?.id }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'enqueueOutboundEmail.threw' },
      'outbound_email_enqueue_threw',
    )
    return { ok: false }
  }
}

/**
 * Build absolute URLs from PUBLIC_APP_URL + relative path. Returns
 * the original href if it's already absolute, or null when env not set.
 */
export function absoluteUrl(href: string | null | undefined): string | null {
  if (!href) return null
  if (/^https?:\/\//i.test(href)) return href
  const base = process.env.PUBLIC_APP_URL || ''
  if (!base) return href
  return `${base.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`
}
