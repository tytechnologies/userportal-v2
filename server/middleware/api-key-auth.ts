// API key authentication middleware.
//
// Runs on every request. Looks for `Authorization: Bearer hipk_*`,
// verifies via api_key_verify(), stashes context.apiKey on success.
//
// Does NOT throw on missing/invalid tokens — endpoints that require
// API-key auth call requireApiKey/requireScope from utils/apiAuth.ts.
// This keeps user-session endpoints unaffected.
//
// Usage logging happens fire-and-forget after the response — see
// the inline comment below for the wiring point.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'

const API_KEY_PREFIX = /^hipk_(live|test|rest)_/

export default defineEventHandler(async (event) => {
  const auth = getRequestHeader(event, 'authorization')
  if (!auth) return
  if (!auth.startsWith('Bearer ')) return

  const token = auth.slice(7).trim()
  if (!API_KEY_PREFIX.test(token)) return

  const admin = getServerSupabaseAdmin()
  let result: any = null
  try {
    const { data } = await (admin as any).rpc('api_key_verify', { p_key: token })
    result = data
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'api-key-auth.verify' },
      'api_key_verify_threw',
    )
    return
  }

  if (!result || !result.id) {
    // Invalid / revoked / expired. Don't throw — let the endpoint
    // decide via requireApiKey() if it cares.
    return
  }

  ;(event.context as any).apiKey = {
    id: result.id,
    organization_id: result.organization_id ?? null,
    scopes: Array.isArray(result.scopes) ? result.scopes : [],
    kind: result.kind,
    rate_limit_per_minute: result.rate_limit_per_minute ?? 60,
  }

  // Wire usage logging at response-write time. h3's `afterResponse`
  // hook gives us the final status code without blocking the
  // request path.
  const startTime = Date.now()
  event.context.__apiKeyStart = startTime

  event.node.res.on('finish', () => {
    const apiKey = (event.context as any).apiKey
    if (!apiKey?.id) return

    const status = event.node.res.statusCode || 0
    const elapsed = Date.now() - (event.context.__apiKeyStart || startTime)
    const ip =
      getRequestHeader(event, 'x-forwarded-for') ??
      getRequestHeader(event, 'x-real-ip') ??
      ''
    const ua = getRequestHeader(event, 'user-agent') ?? ''

    ;(admin as any)
      .rpc('api_key_record_usage', {
        p_api_key_id: apiKey.id,
        p_request_id: getRequestHeader(event, 'x-request-id') ?? null,
        p_method: event.method ?? 'GET',
        p_path: event.path ?? '',
        p_status_code: status,
        p_response_time_ms: elapsed,
        p_ip: ip,
        p_user_agent: ua,
        p_error_code: status >= 400 ? `http_${status}` : null,
      })
      .catch((err: any) => {
        logger.warn(
          { err: err?.message, op: 'api-key-auth.record_usage' },
          'api_key_record_usage_failed',
        )
      })
  })
})
