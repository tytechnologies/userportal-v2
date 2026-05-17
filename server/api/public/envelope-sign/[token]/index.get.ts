// GET /api/public/envelope-sign/:token
//
// External signer landing endpoint. Validates the token, marks the
// recipient state as 'opened' (via the advance RPC), and returns the
// envelope + recipient state + attached documents so the signing UI
// can render.
//
// Uses the service-role admin client because:
//   1. Token validation requires reading envelope_recipient_tokens
//      (RLS blocks this from anon).
//   2. The 'open' transition is recorded via envelope_recipient_advance
//      which checks `session_user IN (postgres, supabase_admin,
//      service_role)` for token-based callers.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'optional',
  handler: async ({ event }) => {
    const token = getRouterParam(event, 'token')
    if (!token || token.length < 32 || token.length > 128) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid token format' })
    }

    const admin = getServerSupabaseAdmin()

    // Look up active token -> recipient -> envelope.
    const { data: tokenRow, error: tokenErr } = await (admin as any)
      .from('envelope_recipient_tokens')
      .select('id, recipient_id, expires_at, consumed_at')
      .eq('token', token)
      .maybeSingle()

    if (tokenErr) {
      logger.error(
        { err: tokenErr.message, op: 'envelope-sign.get.token_lookup' },
        'envelope_sign_token_lookup_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Lookup failed' })
    }
    if (!tokenRow) {
      throw createError({ statusCode: 404, statusMessage: 'Token not found' })
    }
    if (tokenRow.consumed_at) {
      throw createError({ statusCode: 410, statusMessage: 'Token already used' })
    }
    if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      throw createError({ statusCode: 410, statusMessage: 'Token expired' })
    }

    // Mark recipient opened (advance RPC handles state transitions
    // and audit event). Best-effort — opening is idempotent.
    const ip = getRequestHeader(event, 'x-forwarded-for') ?? getRequestHeader(event, 'x-real-ip') ?? null
    const ua = getRequestHeader(event, 'user-agent') ?? null
    await (admin as any)
      .rpc('envelope_recipient_advance', {
        p_recipient_id: tokenRow.recipient_id,
        p_action: 'open',
        p_evidence: {},
        p_ip: ip,
        p_ua: ua,
        p_decline_reason: null,
        p_token: token,
      })
      .catch((err: any) => {
        logger.warn(
          { err: err?.message, op: 'envelope-sign.get.advance_open' },
          'envelope_sign_advance_open_failed',
        )
      })

    // Fetch the recipient + envelope + documents for the signing UI.
    const { data: recipient } = await (admin as any)
      .from('envelope_recipients')
      .select(
        'id, envelope_id, role, sequence, required, state, ' +
          'external_email, external_name, user_id, signed_at, declined_at',
      )
      .eq('id', tokenRow.recipient_id)
      .maybeSingle()

    if (!recipient) {
      throw createError({ statusCode: 404, statusMessage: 'Recipient not found' })
    }

    const { data: envelope } = await (admin as any)
      .from('document_envelopes')
      .select('id, title, message, status, routing_kind, expires_at')
      .eq('id', recipient.envelope_id)
      .maybeSingle()

    const { data: documents } = await (admin as any)
      .from('envelope_documents')
      .select('id, document_draft_id, display_order')
      .eq('envelope_id', recipient.envelope_id)
      .order('display_order', { ascending: true })

    return {
      envelope,
      recipient,
      documents: documents ?? [],
      token_expires_at: tokenRow.expires_at,
    }
  },
})
