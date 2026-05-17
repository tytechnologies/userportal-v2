// POST /api/public/envelope-sign/:token/sign
// Body: { evidence: { kind, ... } }
//
// External signer commits a signature. Validates token, calls the
// advance RPC with action='sign', captures IP and UA. Token is
// consumed atomically with the recipient state transition.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { enqueueOutboundEmail, absoluteUrl } from '~~/server/utils/outboundEmail'

const evidenceSchema = z
  .object({
    kind: z.enum(['png', 'typed', 'click_to_sign']),
    s3_key: z.string().max(500).optional(),
    name_typed: z.string().trim().max(200).optional(),
    consent_text: z.string().trim().max(2000).optional(),
  })
  .strict()

const bodySchema = z.object({
  evidence: evidenceSchema,
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
      p_action: 'sign',
      p_evidence: body.evidence,
      p_ip: ip,
      p_ua: ua,
      p_decline_reason: null,
      p_token: token,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'envelope-sign.sign' },
        'envelope_sign_sign_failed',
      )
      const msg = String(error.message ?? '')
      if (msg.includes('token already consumed') || msg.includes('invalid')) {
        throw createError({ statusCode: 410, statusMessage: 'Token already used or invalid' })
      }
      if (msg.includes('cannot advance') || msg.includes('state must be')) {
        throw createError({ statusCode: 409, statusMessage: msg })
      }
      throw createError({ statusCode: 500, statusMessage: msg || 'Sign failed' })
    }

    // Fan out: if the envelope is now completed, notify the creator.
    notifyEnvelopeCompletion(tokenRow.recipient_id).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'envelope_completion_email_enqueue_failed',
      )
    })

    return { ok: true, recipient_id: data }
  },
})

async function notifyEnvelopeCompletion(recipientId: string): Promise<void> {
  const admin = getServerSupabaseAdmin()

  const { data: recipient } = await (admin as any)
    .from('envelope_recipients')
    .select('envelope_id')
    .eq('id', recipientId)
    .maybeSingle()
  if (!recipient) return

  const { data: envelope } = await (admin as any)
    .from('document_envelopes')
    .select('id, title, status, created_by')
    .eq('id', recipient.envelope_id)
    .maybeSingle()
  if (!envelope) return
  // Only notify on the just-completed transition.
  if (envelope.status !== 'completed') return
  if (!envelope.created_by) return

  const { data: creator } = await (admin as any)
    .from('profiles')
    .select('email, full_name')
    .eq('id', envelope.created_by)
    .maybeSingle()
  if (!creator?.email) return

  await enqueueOutboundEmail({
    to: creator.email,
    toName: creator.full_name ?? null,
    recipientUserId: envelope.created_by,
    templateKind: 'envelope.completed',
    subject: `All parties signed: ${envelope.title}`,
    templateInput: {
      recipientName: creator.full_name ?? null,
      title: envelope.title,
      hrefAbsolute: absoluteUrl(`/envelopes/${envelope.id}`),
    },
    dedupeKey: `envelope-completed:${envelope.id}`,
    referenceKind: 'envelope',
    referenceId: envelope.id,
  })
}
