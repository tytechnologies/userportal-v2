// POST /api/public/envelope-sign/:token/decline
// Body: { reason: string }
//
// External signer declines. If the recipient is required, the
// envelope itself transitions to status='declined'.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { enqueueOutboundEmail, absoluteUrl } from '~~/server/utils/outboundEmail'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'optional',
  handler: async ({ event, body }) => {
    const token = getRouterParam(event, 'token')
    if (!token || token.length < 32 || token.length > 128) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid token format' })
    }

    const admin = getServerSupabaseAdmin()

    const { data: tokenRow } = await (admin as any)
      .from('envelope_recipient_tokens')
      .select('id, recipient_id, expires_at, consumed_at')
      .eq('token', token)
      .maybeSingle()
    if (!tokenRow) {
      throw createError({ statusCode: 404, statusMessage: 'Token not found' })
    }
    if (tokenRow.consumed_at) {
      throw createError({ statusCode: 410, statusMessage: 'Token already used' })
    }
    if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      throw createError({ statusCode: 410, statusMessage: 'Token expired' })
    }

    const ip = getRequestHeader(event, 'x-forwarded-for') ?? getRequestHeader(event, 'x-real-ip') ?? null
    const ua = getRequestHeader(event, 'user-agent') ?? null

    const { data, error } = await (admin as any).rpc('envelope_recipient_advance', {
      p_recipient_id: tokenRow.recipient_id,
      p_action: 'decline',
      p_evidence: {},
      p_ip: ip,
      p_ua: ua,
      p_decline_reason: body.reason,
      p_token: token,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'envelope-sign.decline' },
        'envelope_sign_decline_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Fan out: notify the envelope creator a signer declined.
    notifyEnvelopeDecline(tokenRow.recipient_id, body.reason).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'envelope_decline_email_enqueue_failed',
      )
    })

    return { ok: true, recipient_id: data }
  },
})

async function notifyEnvelopeDecline(recipientId: string, reason: string): Promise<void> {
  const admin = getServerSupabaseAdmin()

  const { data: recipient } = await (admin as any)
    .from('envelope_recipients')
    .select('envelope_id, external_name, external_email, user_id')
    .eq('id', recipientId)
    .maybeSingle()
  if (!recipient) return

  const { data: envelope } = await (admin as any)
    .from('document_envelopes')
    .select('id, title, created_by')
    .eq('id', recipient.envelope_id)
    .maybeSingle()
  if (!envelope?.created_by) return

  const { data: creator } = await (admin as any)
    .from('profiles')
    .select('email, full_name')
    .eq('id', envelope.created_by)
    .maybeSingle()
  if (!creator?.email) return

  // Resolve signer display name (best-effort).
  let signerName: string | null = recipient.external_name ?? null
  if (!signerName && recipient.user_id) {
    const { data: signer } = await (admin as any)
      .from('profiles')
      .select('full_name')
      .eq('id', recipient.user_id)
      .maybeSingle()
    signerName = signer?.full_name ?? null
  }

  await enqueueOutboundEmail({
    to: creator.email,
    toName: creator.full_name ?? null,
    recipientUserId: envelope.created_by,
    templateKind: 'envelope.declined',
    subject: `Declined: ${envelope.title}`,
    templateInput: {
      recipientName: creator.full_name ?? null,
      actorName: signerName,
      title: envelope.title,
      body: reason,
      hrefAbsolute: absoluteUrl(`/envelopes/${envelope.id}`),
    },
    dedupeKey: `envelope-declined:${envelope.id}:${recipientId}`,
    referenceKind: 'envelope',
    referenceId: envelope.id,
  })
}
