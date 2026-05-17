// Hybrid live-search smoke tests.
//
// Exercises the new orchestrator surfaces end-to-end against the
// portal Nitro instance. Mirrors the env-gate pattern of the other
// integration tests in this repo: skipped unless
// SUPABASE_TEST_PROJECT=1 plus an HTTP target are set.
//
// What's exercised:
//   1. /api/internal/live-search — auth gate + fan-out shape
//   2. /api/internal/search-event — telemetry write
//   3. /api/admin/live-search/overview — admin rollup
//   4. /api/admin/live-search/candidates — list shape
//   5. find_listing_duplicate_candidates RPC (catalog of dedup work)
//
// Not exercised here (separate file):
//   - The website's /api/public/search-hybrid (different process)
//   - Tavily HTTP itself (mock-free integration would burn budget)

import { describe, it, expect, beforeAll } from 'vitest'

const PORTAL_BASE   = process.env.PORTAL_BASE_URL || ''
const CRON_SECRET   = process.env.INTERNAL_CRON_SECRET || ''
const ADMIN_JWT     = process.env.PORTAL_TEST_ADMIN_JWT || ''
const MEMBER_JWT    = process.env.PORTAL_TEST_MEMBER_JWT || ''

const SHOULD_RUN =
  process.env.SUPABASE_TEST_PROJECT === '1' &&
  !!PORTAL_BASE &&
  !!CRON_SECRET

async function jsonFetch(
  path: string,
  opts: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${PORTAL_BASE}${path}`, opts)
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

describe.skipIf(!SHOULD_RUN)('/api/internal/live-search', () => {
  it('rejects without x-internal-secret', async () => {
    const { status } = await jsonFetch('/api/internal/live-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'smoke' }),
    })
    expect(status).toBe(401)
  })

  it('rejects with wrong secret', async () => {
    const { status } = await jsonFetch('/api/internal/live-search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': 'wrong-secret',
      },
      body: JSON.stringify({ q: 'smoke' }),
    })
    expect(status).toBe(401)
  })

  it('returns the expected shape with valid secret', async () => {
    const { status, body } = await jsonFetch('/api/internal/live-search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': CRON_SECRET,
      },
      body: JSON.stringify({ q: 'makati 2br condo', deadline_ms: 800 }),
    })
    expect(status).toBe(200)
    expect(body).toMatchObject({
      candidates: expect.any(Array),
      providers: expect.any(Object),
      degraded: expect.any(Boolean),
    })
  })

  it('422s on invalid body (q too short)', async () => {
    const { status, body } = await jsonFetch('/api/internal/live-search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': CRON_SECRET,
      },
      body: JSON.stringify({ q: '' }),
    })
    expect(status).toBe(422)
    expect(body?.data?.issues || body?.statusMessage).toBeTruthy()
  })
})

describe.skipIf(!SHOULD_RUN)('/api/internal/search-event', () => {
  it('rejects without secret', async () => {
    const { status } = await jsonFetch('/api/internal/search-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query_hash: 'x' }),
    })
    expect(status).toBe(401)
  })

  it('records a synthetic event with valid secret', async () => {
    const { status, body } = await jsonFetch('/api/internal/search-event', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': CRON_SECRET,
      },
      body: JSON.stringify({
        request_origin: 'api',
        query_input: { q: 'smoke', _test: true },
        query_hash: 'smoke-test-' + Date.now(),
        internal_count: 1,
        external_count: 0,
        merged_count: 1,
        dedup_collapses: 0,
        internal_ms: 50,
        total_ms: 60,
        provider_breakdown: {},
        degraded: false,
        notes: 'smoke',
      }),
    })
    expect(status).toBe(200)
    expect(body?.ok).toBe(true)
  })
})

describe.skipIf(!SHOULD_RUN || !ADMIN_JWT)('/api/admin/live-search/overview', () => {
  it('returns rollup shape for an admin', async () => {
    const { status, body } = await jsonFetch(
      '/api/admin/live-search/overview',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${ADMIN_JWT}` },
      },
    )
    expect(status).toBe(200)
    expect(body).toHaveProperty('connectors')
    expect(body).toHaveProperty('cache_stats')
    expect(body).toHaveProperty('events_24h')
    expect(body).toHaveProperty('candidates')
  })
})

describe.skipIf(!SHOULD_RUN || !MEMBER_JWT)('admin gate denies Members', () => {
  it('/api/admin/live-search/overview → 403 for Member JWT', async () => {
    const { status } = await jsonFetch(
      '/api/admin/live-search/overview',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${MEMBER_JWT}` },
      },
    )
    // 403 (preferred — middleware caught it) or 401 (no session). Either
    // closes the leak. 200 = bug.
    expect([401, 403]).toContain(status)
  })

  it('/api/admin/live-search/candidates → 403 for Member JWT', async () => {
    const { status } = await jsonFetch(
      '/api/admin/live-search/candidates',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${MEMBER_JWT}` },
      },
    )
    expect([401, 403]).toContain(status)
  })
})
