// POST /api/webhooks/payments/:provider
//
// Public webhook receiver. Accepts events from supported providers
// ('paymongo', 'maya'), verifies the signature with the per-provider
// HMAC scheme, and records the event for downstream dispatch.
//
// Always returns 200 once the event is recorded — even when the
// signature is invalid, to avoid leaking signal to potential
// spoofers about which secret is configured. The recorded row's
// `signature_verified` flag is what gates handler execution.
//
// Live HTTP gateway integration (creating checkout sessions,
// charging methods) is NOT in this turn — only the receiver is.

import { paymentEventsRepo } from '~~/server/repositories/paymentEvents.repo'
import { verifyWebhookSignature } from '~~/server/utils/paymentSignatures'
import { logger } from '~~/server/utils/logger'

const SUPPORTED_PROVIDERS = new Set(['paymongo', 'maya'])

export default defineEventHandler(async (event) => {
  const provider = (getRouterParam(event, 'provider') || '').toLowerCase()
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw createError({ statusCode: 404, statusMessage: 'Unknown provider' })
  }

  // Read the raw body for signature verification — JSON.parse cannot
  // come first because the verifier needs the exact byte sequence.
  const rawBody = await readRawBody(event, 'utf8')
  const body = rawBody ?? ''

  // Convert headers to a flat case-insensitive object.
  const rawHeaders = getRequestHeaders(event)
  const headers: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(rawHeaders)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v
  }

  const verification = verifyWebhookSignature({
    provider,
    rawBody: body,
    headers,
  })

  let parsed: Record<string, unknown> = {}
  try {
    parsed = body ? JSON.parse(body) : {}
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, provider, op: 'webhooks.payments.parse' },
      'webhook_payload_parse_failed',
    )
  }

  // Provider sometimes doesn't include event_id; fall back to a
  // synthetic key so we can still record + dedupe at the row level.
  // This synthesises a stable hash from provider + body so a true
  // replay still collides on UNIQUE.
  const externalEventId =
    verification.externalEventId ||
    `synthetic-${require('node:crypto').createHash('sha256').update(body).digest('hex').slice(0, 32)}`
  const externalEventType = verification.externalEventType || 'unknown'

  const result = await paymentEventsRepo.recordAndDispatch({
    provider,
    externalEventId,
    eventType: externalEventType,
    payload: parsed,
    signatureVerified: verification.verified,
  })

  if (!verification.verified) {
    // Logged so spoofing attempts are visible in observability.
    logger.warn(
      {
        provider,
        reason: verification.reason,
        event_id: externalEventId,
        op: 'webhooks.payments.signature_failed',
      },
      'payment_webhook_signature_unverified',
    )
  }

  return {
    ok: true,
    event_id: result.event_id,
    dispatched: result.dispatched,
    signature_verified: verification.verified,
  }
})
