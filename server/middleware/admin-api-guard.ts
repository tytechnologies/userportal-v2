// Default RBAC gate for the entire /api/admin/* namespace.
//
// Smoke-test 2026-05-14 surfaced inconsistent guards across admin
// endpoints — some explicitly check role (e.g. organizations) and
// return 403, others (platform-settings) just declared `auth: required`
// and returned 200 with table-RLS doing the filtering. The day someone
// populates an admin-only table with sensitive data, the gap leaks it.
//
// This middleware closes the gap structurally:
//   - any request matching `/api/admin/*` (and not in the allowlist)
//     must be from a caller with role >= admin
//   - non-admin callers get a 403 with `{ error: 'admin_required' }`
//   - returning early prevents the actual handler from executing
//
// Per-endpoint role checks (e.g. `await requireRole(event, 'admin')`)
// remain — they double-gate harmlessly. New endpoints get the gate for
// free without remembering to opt in.
//
// Exceptions:
//   - `/api/admin/docs/[slug]` is admin-gated at the page-loader level
//     for a reason that pre-dates this middleware (Markdown doc fetch);
//     no exception needed since admins can still access.
//   - If an endpoint genuinely needs broader access (e.g. agents/
//     managers can call it), add the prefix to ADMIN_API_ALLOWLIST.

import type { H3Event } from 'h3'
import { getUserRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const ADMIN_API_PREFIX = '/api/admin/'

// Allowlist of path prefixes that opt OUT of the admin gate. Empty by
// default — any genuinely broader-access admin endpoint adds its
// prefix here with a code comment explaining why.
const ADMIN_API_ALLOWLIST: string[] = [
  // Example (none today): '/api/admin/foo-public/',
]

function pathOf(event: H3Event): string {
  const url = event.node.req.url ?? ''
  // Strip query string. PostgREST-style trailing slash variants don't
  // matter — we match on prefix.
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

function isAllowlisted(path: string): boolean {
  for (const prefix of ADMIN_API_ALLOWLIST) {
    if (path.startsWith(prefix)) return true
  }
  return false
}

export default defineEventHandler(async (event) => {
  const path = pathOf(event)
  if (!path.startsWith(ADMIN_API_PREFIX)) return
  if (isAllowlisted(path)) return

  let role: string
  try {
    role = await getUserRole(event)
  } catch (err) {
    // getUserRole defaults to 'agent' on any error; explicit fallthrough
    // shouldn't fire, but be defensive.
    logger.warn(
      { err: (err as any)?.message, op: 'admin-api-guard.role-lookup', path },
      'admin_api_guard_role_lookup_failed',
    )
    role = 'agent'
  }

  if (role !== 'admin') {
    logger.info(
      { role, path, op: 'admin-api-guard.denied' },
      'admin_api_guard_denied',
    )
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden: admin role required',
      data: { error: 'admin_required' },
    })
  }
})
