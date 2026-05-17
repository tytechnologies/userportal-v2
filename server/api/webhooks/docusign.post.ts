// DocuSign Connect webhook receiver.
//
// POST /api/webhooks/docusign
// Headers: X-DocuSign-Signature-1 (HMAC-SHA256 over raw body)
//
// DocuSign Connect ships envelope status updates to this URL. We:
//   1. Verify the HMAC against platform_settings.docusign.webhook_secret
//   2. Parse the envelope id + new status from the body
//   3. Update the docusign_envelopes row + project signed_at onto
//      the matching draft._signature_placeholders entries
//
// Auth is webhook-style — no user session, RLS bypassed via
// service-role client. The HMAC check is the security gate.

import { z } from 'zod'
import crypto from 'node:crypto'
import { serverSupabaseServiceRole } from '#supabase/server/serverSupabaseServiceRole'
import { logger } from '~~/server/utils/logger'
import { readDocusignConfig } from '~~/server/utils/docusign'
import { logActivity } from '~~/server/utils/audit'

// DocuSign Connect ships either XML or JSON depending on configuration.
// We accept both — Nuxt's readBody parses JSON; we read raw for XML
// fallback so the HMAC-of-body check works on either.
async function readRaw(event: any): Promise<string> {
  const buf = await readRawBody(event, 'utf8')
  return typeof buf === 'string' ? buf : ''
}

const STATUS_MAP: Record<string, string> = {
  sent:        'sent',
  delivered:   'delivered',
  completed:   'completed',
  declined:    'declined',
  voided:      'voided',
  expired:     'expired',
  // DocuSign sometimes ships "envelope-completed" capitalization.
  Sent:        'sent',
  Delivered:   'delivered',
  Completed:   'completed',
  Declined:    'declined',
  Voided:      'voided',
}

export default defineEventHandler(async (event) => {
  const cfg = await readDocusignConfig(event)
  if (!cfg.webhook_secret) {
    logger.warn({ op: 'docusign.webhook' }, 'docusign_webhook_no_secret_configured')
    throw createError({
      statusCode: 503,
      statusMessage: 'DocuSign webhook secret is not configured',
    })
  }

  const raw = await readRaw(event)
  const sigHeader = getHeader(event, 'x-docusign-signature-1') ?? ''
  // Constant-time compare so attackers can't time-side-channel.
  const expected = crypto
    .createHmac('sha256', cfg.webhook_secret)
    .update(raw, 'utf8')
    .digest('base64')
  const sigOk =
    expected.length === sigHeader.length &&
    crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(sigHeader, 'utf8'),
    )
  if (!sigOk) {
    logger.warn({ op: 'docusign.webhook' }, 'docusign_webhook_bad_signature')
    throw createError({ statusCode: 401, statusMessage: 'Bad webhook signature' })
  }

  // Parse JSON; if it fails, parse XML lazily. Most modern DocuSign
  // accounts use the JSON Connect format.
  let payload: any = null
  try {
    payload = JSON.parse(raw)
  } catch {
    // Minimal XML extraction — pull EnvelopeId + EnvelopeStatus and
    // recipient statuses. A full XML parser (fast-xml-parser) would
    // be more robust; deferred until a customer actually needs XML.
    const id = /<EnvelopeID>([0-9a-f-]{36})<\/EnvelopeID>/i.exec(raw)?.[1]
    const status = /<Status>(\w+)<\/Status>/i.exec(raw)?.[1]
    if (id && status) payload = { envelopeId: id, status }
  }

  const envelopeId = payload?.data?.envelopeId ?? payload?.envelopeId ?? null
  const rawStatus = payload?.data?.envelopeSummary?.status ?? payload?.status ?? null
  const newStatus = rawStatus ? (STATUS_MAP[rawStatus] ?? rawStatus.toLowerCase()) : null

  if (!envelopeId || !newStatus) {
    logger.warn(
      { op: 'docusign.webhook', payload: typeof payload === 'object' ? Object.keys(payload || {}) : null },
      'docusign_webhook_unparseable',
    )
    setResponseStatus(event, 200)
    return { ok: true, ignored: true }
  }

  const sr = serverSupabaseServiceRole(event) as any

  // Find the envelope row + parent draft.
  const { data: envRow, error: envErr } = await sr
    .from('docusign_envelopes')
    .select('id, draft_id, recipients')
    .eq('envelope_id', envelopeId)
    .maybeSingle()
  if (envErr) {
    logger.error({ err: envErr.message, op: 'docusign.webhook.find' }, 'docusign_webhook_find_failed')
    throw createError({ statusCode: 500, statusMessage: envErr.message })
  }
  if (!envRow) {
    // Envelope from another tenant or cleaned-up draft. 200 so
    // DocuSign doesn't retry indefinitely.
    setResponseStatus(event, 200)
    return { ok: true, unknown_envelope: true }
  }

  // Project recipient statuses if the payload carries them.
  const recipientUpdates =
    payload?.data?.envelopeSummary?.recipients?.signers ??
    payload?.recipients?.signers ?? []
  const updatedRecipients = (envRow.recipients ?? []).map((r: any) => {
    const match = recipientUpdates.find(
      (u: any) => (u?.email ?? '').toLowerCase() === (r.email ?? '').toLowerCase(),
    )
    if (!match) return r
    const recStatus = (match.status ?? '').toLowerCase()
    const signedAt =
      recStatus === 'completed' || recStatus === 'signed'
        ? (match.signedDateTime ?? new Date().toISOString())
        : r.signed_at
    return { ...r, status: recStatus || r.status, signed_at: signedAt ?? r.signed_at }
  })

  const updateRow: Record<string, unknown> = {
    status: newStatus,
    recipients: updatedRecipients,
    webhook_received_at: new Date().toISOString(),
  }
  if (newStatus === 'completed') updateRow.completed_at = new Date().toISOString()
  if (newStatus === 'voided')    updateRow.voided_at    = new Date().toISOString()

  const { error: upErr } = await sr
    .from('docusign_envelopes')
    .update(updateRow)
    .eq('id', envRow.id)
  if (upErr) {
    logger.error({ err: upErr.message, op: 'docusign.webhook.update' }, 'docusign_webhook_update_failed')
    throw createError({ statusCode: 500, statusMessage: upErr.message })
  }

  // Project signed_at onto the parent draft's signature placeholders
  // so the broker UI shows the same "signed" badge whether the user
  // signed in DocuSign or marked manually.
  const { data: draft } = await sr
    .from('document_drafts')
    .select('id, data')
    .eq('id', envRow.draft_id)
    .maybeSingle()
  if (draft) {
    const data = (draft.data ?? {}) as Record<string, unknown>
    const placeholders = Array.isArray(data._signature_placeholders)
      ? (data._signature_placeholders as Array<Record<string, unknown>>)
      : []
    const updatedPlaceholders = placeholders.map((p) => {
      const match = updatedRecipients.find(
        (r: any) => r.placeholder_id === p.id && r.signed_at,
      )
      if (!match) return p
      return { ...p, signed_at: match.signed_at }
    })
    await sr
      .from('document_drafts')
      .update({ data: { ...data, _signature_placeholders: updatedPlaceholders } })
      .eq('id', draft.id)
  }

  await logActivity({
    event,
    client: sr,
    action: ('document_draft.esign_' + newStatus) as any,
    entity: 'document',
    metadata: {
      draft_id: envRow.draft_id,
      envelope_id: envelopeId,
      status: newStatus,
    },
  })

  setResponseStatus(event, 200)
  return { ok: true }
})
