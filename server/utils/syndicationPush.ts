// Listing-syndication push runner.
//
// POSTs a serialized feed body to a partner's `push_endpoint_url`
// with the right auth header, captures response status + a body
// excerpt for audit, and returns a structured outcome.
//
// Secret resolution: `push_secret_vault_key` on the target row is
// treated as an ENV VAR NAME — `process.env[push_secret_vault_key]`.
// This avoids depending on Supabase Vault (paid feature) for v1; if a
// future tier adopts Vault, only this resolver changes. Operators
// store the actual secret as an env var in AWS / Cloudflare and
// reference it by name from the target row. Names that look like
// secrets ("LAMUDI_SECRET=…") leak in logs less than the secret itself.
//
// Auth shapes:
//   none   — no auth header
//   bearer — Authorization: Bearer <secret>
//   hmac   — X-HHI-Timestamp + X-HHI-Signature (sha256 hex of
//            `<timestamp>.<body>` keyed on the secret)
//   basic  — Authorization: Basic <base64(secret)> — secret is
//            expected to be already in `user:pass` shape

import { createHmac } from 'node:crypto'
import { logger } from './logger'

export type PushTarget = {
  id: string
  slug: string
  push_endpoint_url: string | null
  push_auth_kind: 'none' | 'bearer' | 'hmac' | 'basic' | null
  push_secret_vault_key: string | null
}

export type PushOutcome = {
  ok: boolean
  status_code: number | null
  body_excerpt: string | null
  duration_ms: number
  error?: string
}

const REQ_TIMEOUT_MS = 30_000
const BODY_EXCERPT_MAX = 2_048

function resolveSecret(target: PushTarget): string | null {
  if (!target.push_secret_vault_key) return null
  const v = process.env[target.push_secret_vault_key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function buildHeaders(
  target: PushTarget,
  contentType: string,
  body: string,
): { headers: Record<string, string>; missingSecret: boolean } {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'user-agent': 'HousingInteractive-Syndication/1.0',
  }
  if (!target.push_auth_kind || target.push_auth_kind === 'none') {
    return { headers, missingSecret: false }
  }
  const secret = resolveSecret(target)
  if (!secret) {
    return { headers, missingSecret: true }
  }
  if (target.push_auth_kind === 'bearer') {
    headers['authorization'] = `Bearer ${secret}`
  } else if (target.push_auth_kind === 'basic') {
    headers['authorization'] = `Basic ${Buffer.from(secret).toString('base64')}`
  } else if (target.push_auth_kind === 'hmac') {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    headers['x-hhi-timestamp'] = timestamp
    headers['x-hhi-signature'] = signature
  }
  return { headers, missingSecret: false }
}

export async function pushFeedToTarget(
  target: PushTarget,
  contentType: string,
  body: string,
): Promise<PushOutcome> {
  const startedAt = Date.now()

  if (!target.push_endpoint_url) {
    return {
      ok: false,
      status_code: null,
      body_excerpt: null,
      duration_ms: 0,
      error: 'push_endpoint_url is not set on the target',
    }
  }

  const { headers, missingSecret } = buildHeaders(target, contentType, body)
  if (missingSecret) {
    return {
      ok: false,
      status_code: null,
      body_excerpt: null,
      duration_ms: 0,
      error: `push_secret_vault_key="${target.push_secret_vault_key}" not set in env (or empty)`,
    }
  }

  // Browser fetch (Node 18+) with AbortController for timeout. We
  // explicitly do not enable redirect-following — partner endpoints
  // should land on the canonical URL; bouncing through a redirect
  // could leak the auth header to an unintended host.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS)
  try {
    const res = await fetch(target.push_endpoint_url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    const excerpt = text.length > BODY_EXCERPT_MAX ? text.slice(0, BODY_EXCERPT_MAX) + '\n…' : text
    return {
      ok: res.status >= 200 && res.status < 300,
      status_code: res.status,
      body_excerpt: excerpt || null,
      duration_ms: Date.now() - startedAt,
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'syndication.push', target_id: target.id },
      'syndication_push_failed',
    )
    return {
      ok: false,
      status_code: null,
      body_excerpt: null,
      duration_ms: Date.now() - startedAt,
      error: err?.name === 'AbortError'
        ? `request timed out after ${REQ_TIMEOUT_MS}ms`
        : (err?.message ?? 'unknown'),
    }
  } finally {
    clearTimeout(timeout)
  }
}
