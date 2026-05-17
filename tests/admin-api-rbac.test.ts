// Admin-route RBAC probe.
//
// Walks the filesystem for every /api/admin/* endpoint handler and
// asserts that a Member-role JWT receives 403. This prevents the
// "the day someone populates the table the data leaks" failure mode
// the smoke-test report flagged:
//   - /api/admin/organizations → 403 (explicit requireRole)
//   - /api/admin/platform-settings → 200 (no role check) ← LEAKS
//
// With the server/middleware/admin-api-guard.ts in place every admin
// route inherits a default-deny. This test is the regression guard.
//
// Env gate:
//   SUPABASE_TEST_PROJECT=1                — opt-in (same shape as
//                                             other tests in this repo)
//   PORTAL_BASE_URL=http://localhost:3002  — running portal instance
//   PORTAL_TEST_MEMBER_JWT=<jwt>           — a Member-role user's JWT
//
// All three required. When any is missing the suite is skipped (and
// the test runner stays green so CI doesn't false-positive in envs
// where the integration target isn't running).

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const PORTAL_BASE = process.env.PORTAL_BASE_URL || ''
const MEMBER_JWT  = process.env.PORTAL_TEST_MEMBER_JWT || ''

const SHOULD_RUN =
  process.env.SUPABASE_TEST_PROJECT === '1' && !!PORTAL_BASE && !!MEMBER_JWT

const ADMIN_API_DIR = join(
  process.cwd(),
  'server', 'api', 'admin',
)

// Endpoints that intentionally permit non-admin access. Keep in sync
// with ADMIN_API_ALLOWLIST in server/middleware/admin-api-guard.ts.
const ALLOWLIST_PATHS: string[] = [
  // none today
]

/**
 * Map a handler-file path on disk to the URL path it serves. Nuxt's
 * file router rules:
 *   - foo.get.ts        → GET /foo
 *   - [id].patch.ts     → PATCH /<route>/{id}
 *   - index.<verb>.ts   → <VERB> /<dir>
 *   - any subdir        → segment in path
 */
function handlerFileToRoute(absPath: string): { method: string; route: string } | null {
  const rel = relative(ADMIN_API_DIR, absPath).split(sep).join('/')
  const m = /^(?<rest>.+?)\.(?<verb>get|post|patch|delete|put|options)\.ts$/i.exec(rel)
  if (!m || !m.groups) return null
  const method = m.groups.verb.toUpperCase()
  let route = m.groups.rest
  // index → empty segment (the dir itself)
  route = route.replace(/(^|\/)index$/, '')
  // [param] → {param} so test invocations can rough-stub
  route = route.replace(/\[([^\]]+)\]/g, '{$1}')
  return { method, route: `/api/admin/${route}` }
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (st.isFile() && /\.(get|post|patch|delete|put|options)\.ts$/i.test(entry)) {
      acc.push(p)
    }
  }
  return acc
}

let routes: Array<{ method: string; route: string }> = []

beforeAll(() => {
  if (!SHOULD_RUN) return
  const handlerFiles = walk(ADMIN_API_DIR)
  for (const f of handlerFiles) {
    const r = handlerFileToRoute(f)
    if (r) routes.push(r)
  }
})

describe.skipIf(!SHOULD_RUN)('Admin API RBAC probe — Member JWT must hit 403', () => {
  it('discovered some admin routes to probe', () => {
    expect(routes.length).toBeGreaterThan(0)
  })

  // One test per route — easy to spot which route slipped through.
  it('every route is admin-gated OR in the allowlist', async () => {
    const leaks: Array<{ route: string; method: string; status: number }> = []
    for (const { method, route } of routes) {
      if (ALLOWLIST_PATHS.some((p) => route.startsWith(p))) continue

      // Stub path-params with dummy values. The middleware fires BEFORE
      // the handler runs, so we never actually exercise the handler —
      // the 403 should fire on auth alone.
      const probeUrl =
        route.replace(/\{[^}]+\}/g, '00000000-0000-0000-0000-000000000000')

      const res = await fetch(`${PORTAL_BASE}${probeUrl}`, {
        method: method === 'GET' || method === 'DELETE' ? method : method,
        headers: {
          authorization: `Bearer ${MEMBER_JWT}`,
          'content-type': 'application/json',
        },
        body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : undefined,
      })

      // 401 (no session) and 403 (no role) both close the leak. 404
      // also acceptable when the path-param stub doesn't resolve to a
      // real row — the route was reached but no data leaked.
      if (res.status === 200 || res.status === 201) {
        leaks.push({ route, method, status: res.status })
      }
    }

    if (leaks.length > 0) {
      console.error('Routes responding 200/201 to Member JWT:')
      for (const l of leaks) console.error(`  ${l.method} ${l.route} → ${l.status}`)
    }
    expect(leaks).toEqual([])
  }, 120_000) // ample timeout — could be 100+ routes
})
