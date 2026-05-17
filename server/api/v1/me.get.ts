// GET /api/v1/me
//
// API-key auth ping. Returns the calling key's identity, scopes, and
// rate limit. Useful for integration partners to verify their key
// works and inspect their entitlements.
//
// Requires the `api_keys.manage.own` scope is NOT required — any
// active key can read its own context. Use requireApiKey() to gate
// out user-session callers.

import { requireApiKey } from '~~/server/utils/apiAuth'

export default defineEventHandler((event) => {
  const key = requireApiKey(event)
  return {
    api_key: {
      id: key.id,
      organization_id: key.organization_id,
      kind: key.kind,
      scopes: key.scopes,
      rate_limit_per_minute: key.rate_limit_per_minute,
    },
  }
})
