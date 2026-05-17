// Rate-limit wrapper around the public.check_rate_limit RPC.
//
// Use from public POST endpoints to protect against bursts / abuse.
// Backed by a database-resident bucket table (see migration
// 20260506000016) so multi-instance Nuxt deploys agree on counts.
//
// Failure policy: FAIL OPEN. If the RPC call fails (DB transient,
// migration not applied yet, RLS error), the request is allowed
// through with a warn-log. Better to over-serve than to DOS ourselves
// with a flaky limiter — the same posture as notify() and audit().

import type { H3Event } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from './logger'

type CheckResult = {
  allowed: boolean
  count: number
  limit: number
  window_started_at: string
  reset_at: string
}

/**
 * Stable client identifier for rate-limit bucketing.
 *
 * Trust order:
 *   1. cf-connecting-ip — set by Cloudflare; spoofable only if your
 *      origin is reachable bypassing CF (out of scope here).
 *   2. x-forwarded-for first hop — set by AWS ALB / LB. Spoofable only
 *      if the LB doesn't strip client-supplied XFF (it does).
 *   3. event request IP — direct connection (dev / debugging).
 *
 * IPv6 is truncated to its /64 prefix so a single attacker can't
 * rotate through their /128 allocation. IPv4-mapped v6 (`::ffff:1.2.3.4`)
 * is detected and the v4 portion used.
 */
export function clientIp(event: H3Event): string {
  const headers = event.node.req.headers as Record<string, string | string[] | undefined>

  const cf = (headers['cf-connecting-ip'] as string | undefined)?.trim()
  if (cf) return normalize(cf)

  const xff = (headers['x-forwarded-for'] as string | undefined)?.trim()
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return normalize(first)
  }

  const remote = event.node.req.socket?.remoteAddress
  if (remote) return normalize(remote)

  // Fallback: empty string. RPC short-circuits to allowed when key is
  // empty, which is the right behavior — we'd rather not bucket all
  // unidentified traffic together.
  return ''
}

function normalize(ip: string): string {
  // Strip surrounding brackets some proxies add: `[::1]:1234` → `::1`.
  let v = ip.replace(/^\[/, '').replace(/].*$/, '').trim()

  // Strip port if present on IPv4 (`1.2.3.4:5678` → `1.2.3.4`).
  // (IPv6 ports require brackets which we've already stripped.)
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) {
    v = v.split(':')[0] ?? v
  }

  // IPv4-mapped v6 (`::ffff:1.2.3.4`) → keep as v4.
  const v4mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4mapped) return v4mapped[1] || v

  // IPv6: truncate to /64 (first 4 groups) so a single user's /128
  // can't rotate to bypass the limit. IPv4 left as-is.
  if (v.includes(':')) {
    const parts = v.split(':')
    if (parts.length > 4) {
      return parts.slice(0, 4).join(':') + '::/64'
    }
  }

  return v
}

/**
 * Atomic check + increment. Throws 429 if the bucket is over its
 * limit. Sets standard `Retry-After` and `X-RateLimit-*` headers
 * before throwing.
 *
 * @param event           H3 event (for setting response headers)
 * @param client          Supabase client (any role — RPC is SECURITY DEFINER)
 * @param key             Surface-prefixed bucket key, e.g. 'inquiries:1.2.3.4'
 * @param max             Max requests per window
 * @param windowSeconds   Window length in seconds
 */
export async function enforceRateLimit(args: {
  event: H3Event
  client: SupabaseClient
  key: string
  max: number
  windowSeconds: number
}): Promise<void> {
  const { event, client, key, max, windowSeconds } = args

  let result: CheckResult | null = null
  try {
    const { data, error } = await (client as any).rpc('check_rate_limit', {
      p_key: key,
      p_max: max,
      p_window_seconds: windowSeconds,
    })
    if (error) {
      throw new Error(error.message)
    }
    result = data as CheckResult
  } catch (err: any) {
    // FAIL OPEN — log + allow. See header comment for rationale.
    logger.warn(
      { err: err?.message, key, op: 'rate_limit.check' },
      'rate_limit_rpc_failed_allowing',
    )
    return
  }

  if (!result || result.allowed) {
    // Set advisory headers on success too, so polite clients can
    // back off before they trip the limit.
    if (result) {
      setHeader(event, 'x-ratelimit-limit', String(result.limit))
      setHeader(event, 'x-ratelimit-remaining', String(Math.max(0, result.limit - result.count)))
      setHeader(event, 'x-ratelimit-reset', String(Math.ceil(new Date(result.reset_at).getTime() / 1000)))
    }
    return
  }

  // Over the limit. Compute Retry-After in seconds (round up).
  const resetMs = new Date(result.reset_at).getTime()
  const retrySec = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
  setHeader(event, 'retry-after', retrySec)
  setHeader(event, 'x-ratelimit-limit', String(result.limit))
  setHeader(event, 'x-ratelimit-remaining', '0')
  setHeader(event, 'x-ratelimit-reset', String(Math.ceil(resetMs / 1000)))

  throw createError({
    statusCode: 429,
    statusMessage: 'Too many requests',
    data: {
      retry_after_seconds: retrySec,
      limit: result.limit,
      window_started_at: result.window_started_at,
    },
  })
}
