// API key authentication helpers.
//
// The middleware (server/middleware/api-key-auth.ts) extracts a
// Bearer token from incoming requests and, if it parses as an API
// key, verifies it via api_key_verify and stashes the result in
// event.context.apiKey.
//
// Endpoints opt-in to scope checks via requireScope(event, 'foo:bar').
// User sessions bypass scope checks (the user's session implies all
// scopes for their own org); only API-key callers are gated.

import type { H3Event } from 'h3'

export type ApiKeyContext = {
  id: string
  organization_id: string | null
  scopes: string[]
  kind: 'live' | 'test' | 'restricted'
  rate_limit_per_minute: number
}

/** Returns the API key context if the caller is an API key, else null. */
export function getApiKey(event: H3Event): ApiKeyContext | null {
  const ctx = (event.context as any).apiKey
  return ctx && typeof ctx === 'object' && ctx.id ? (ctx as ApiKeyContext) : null
}

/** True when the API key has the given scope. */
export function hasScope(event: H3Event, scope: string): boolean {
  const k = getApiKey(event)
  if (!k) return false
  return k.scopes.includes(scope)
}

/**
 * Throws 403 if the API-key caller lacks the scope. User sessions
 * (no apiKey context) pass through — wire RBAC checks separately.
 */
export function requireScope(event: H3Event, scope: string): void {
  const k = getApiKey(event)
  if (!k) {
    // No API key — let the standard auth path decide. Endpoints that
    // want to require API-key auth specifically should use
    // requireApiKey() below instead.
    return
  }
  if (!k.scopes.includes(scope)) {
    throw createError({
      statusCode: 403,
      statusMessage: `API key missing required scope '${scope}'`,
      data: { required_scope: scope, present_scopes: k.scopes },
    })
  }
}

/**
 * Throws 401 if the caller is not authenticated as an API key.
 * Use on /api/v1/* endpoints that should ONLY accept API keys.
 */
export function requireApiKey(event: H3Event): ApiKeyContext {
  const k = getApiKey(event)
  if (!k) {
    throw createError({
      statusCode: 401,
      statusMessage: 'API key required',
      data: { auth_scheme: 'Bearer hipk_*' },
    })
  }
  return k
}
