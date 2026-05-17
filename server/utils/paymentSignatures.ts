// Per-provider webhook signature verification.
//
// Real HMAC validation is provider-specific (PayMongo uses
// HMAC-SHA256 with `Paymongo-Signature`; Maya uses similar). The
// concrete verifiers ship in a follow-up turn alongside the gateway
// HTTP client + API keys. For now this module:
//
//   - Returns `verified: false` for any provider until configured
//     (fail-closed; recorded in payment_gateway_events.signature_verified)
//   - Centralises the dispatch so adding a verifier is one place
//
// The webhook endpoint records ALL inbound events (so spoofing
// attempts are auditable), but the dispatch handler only acts on
// events with `signature_verified=true`.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type SignatureContext = {
  provider: string
  rawBody: string
  headers: Record<string, string | undefined>
}

export type VerificationResult = {
  verified: boolean
  /** event_id derived from the request when the provider includes one. */
  externalEventId?: string
  /** event_type derived from the body. */
  externalEventType?: string
  reason?: string
}

/** PayMongo expects HMAC-SHA256 of the raw body with the webhook secret. */
function verifyPaymongo(ctx: SignatureContext): VerificationResult {
  const sig = ctx.headers['paymongo-signature']
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET
  if (!sig) return { verified: false, reason: 'missing Paymongo-Signature header' }
  if (!secret) return { verified: false, reason: 'PAYMONGO_WEBHOOK_SECRET not configured' }

  // PayMongo signature format: t=<timestamp>,te=<test sig>,li=<live sig>
  // For initial scaffold, parse and compare HMAC against `li` (live).
  const parts = Object.fromEntries(
    sig.split(',').map((p) => {
      const [k, v] = p.split('=', 2)
      return [(k ?? '').trim(), (v ?? '').trim()]
    }),
  )
  const ts = parts.t
  const expectedSig = parts.li ?? parts.te
  if (!ts || !expectedSig) {
    return { verified: false, reason: 'malformed Paymongo-Signature header' }
  }

  const payloadToSign = `${ts}.${ctx.rawBody}`
  const computed = createHmac('sha256', secret).update(payloadToSign).digest('hex')
  let ok = false
  try {
    ok = timingSafeEqual(Buffer.from(computed), Buffer.from(expectedSig))
  } catch {
    ok = false
  }

  let externalEventId: string | undefined
  let externalEventType: string | undefined
  try {
    const parsed = JSON.parse(ctx.rawBody)
    externalEventId = parsed?.data?.id
    externalEventType = parsed?.data?.attributes?.type
  } catch {
    // ignore
  }

  return {
    verified: ok,
    externalEventId,
    externalEventType,
    reason: ok ? undefined : 'HMAC mismatch',
  }
}

/** Maya stub. Real verification ships with the integration turn. */
function verifyMaya(ctx: SignatureContext): VerificationResult {
  const sig = ctx.headers['maya-signature']
  const secret = process.env.MAYA_WEBHOOK_SECRET
  if (!sig) return { verified: false, reason: 'missing Maya-Signature header' }
  if (!secret) return { verified: false, reason: 'MAYA_WEBHOOK_SECRET not configured' }

  // TODO: Maya's actual HMAC scheme. For now, a conservative
  // SHA-256 over the body — replace with the published spec when
  // the integration turn lands.
  const computed = createHmac('sha256', secret).update(ctx.rawBody).digest('hex')
  let ok = false
  try {
    ok = timingSafeEqual(Buffer.from(computed), Buffer.from(sig))
  } catch {
    ok = false
  }

  let externalEventId: string | undefined
  let externalEventType: string | undefined
  try {
    const parsed = JSON.parse(ctx.rawBody)
    externalEventId = parsed?.id
    externalEventType = parsed?.event
  } catch {
    // ignore
  }

  return {
    verified: ok,
    externalEventId,
    externalEventType,
    reason: ok ? undefined : 'HMAC mismatch',
  }
}

export function verifyWebhookSignature(ctx: SignatureContext): VerificationResult {
  switch (ctx.provider) {
    case 'paymongo':
      return verifyPaymongo(ctx)
    case 'maya':
      return verifyMaya(ctx)
    default:
      return {
        verified: false,
        reason: `unknown provider '${ctx.provider}'`,
      }
  }
}
