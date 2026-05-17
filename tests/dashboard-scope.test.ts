// Dashboard role-scoping smoke tests.
//
// Regression armor for the 2026-05-14 fix where dashboard endpoints
// were returning platform-wide counts to brokers/agents instead of
// scoping to their own listings/inquiries/deals. RLS on listings is
// permissive for the MLS cross-broker visibility feature, so the
// scope filter must be applied explicitly in the endpoint.
//
// Each endpoint should:
//   - return scope='admin' when called with an admin JWT
//   - return scope='agent' when called with a non-admin JWT
//   - agent's counts must be <= admin's counts (proper subset)
//
// Env-gated. Requires both an admin JWT and an agent/member JWT
// against the same Supabase project.

import { describe, it, expect } from 'vitest'

const PORTAL_BASE = process.env.PORTAL_BASE_URL || ''
const ADMIN_JWT   = process.env.PORTAL_TEST_ADMIN_JWT || ''
const AGENT_JWT   = process.env.PORTAL_TEST_AGENT_JWT || ''

const SHOULD_RUN =
  process.env.SUPABASE_TEST_PROJECT === '1' &&
  !!PORTAL_BASE && !!ADMIN_JWT && !!AGENT_JWT

async function get(path: string, jwt: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${PORTAL_BASE}${path}`, {
    headers: { authorization: `Bearer ${jwt}` },
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

describe.skipIf(!SHOULD_RUN)('/api/dashboard/stats role scope', () => {
  it('admin sees scope=admin', async () => {
    const { status, body } = await get('/api/dashboard/stats', ADMIN_JWT)
    expect(status).toBe(200)
    expect(body?.scope).toBe('admin')
  })

  it('agent sees scope=agent', async () => {
    const { status, body } = await get('/api/dashboard/stats', AGENT_JWT)
    expect(status).toBe(200)
    expect(body?.scope).toBe('agent')
  })

  it('agent KPIs are a subset of admin KPIs', async () => {
    const [a, b] = await Promise.all([
      get('/api/dashboard/stats', ADMIN_JWT),
      get('/api/dashboard/stats', AGENT_JWT),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // active_listings: agent owns <= total platform listings.
    expect(b.body.kpi.active_listings).toBeLessThanOrEqual(a.body.kpi.active_listings)
    // new_inquiries_7d, deals — same subset rule.
    expect(b.body.kpi.new_inquiries_7d).toBeLessThanOrEqual(a.body.kpi.new_inquiries_7d)
    expect(b.body.pipeline.open_deals_count)
      .toBeLessThanOrEqual(a.body.pipeline.open_deals_count)
  })
})

describe.skipIf(!SHOULD_RUN)('/api/dashboard/attention role scope', () => {
  it('admin sees scope=admin AND has platform-ops sections', async () => {
    const { status, body } = await get('/api/dashboard/attention', ADMIN_JWT)
    expect(status).toBe(200)
    expect(body?.scope).toBe('admin')
    // Admin sees these surfaces; agent doesn't.
    expect(body?.sections?.duplicate_candidates).toBeTruthy()
    expect(body?.sections?.failed_imports).toBeTruthy()
    expect(body?.sections?.failing_webhooks).toBeTruthy()
  })

  it('agent sees scope=agent AND ops sections are zeroed', async () => {
    const { status, body } = await get('/api/dashboard/attention', AGENT_JWT)
    expect(status).toBe(200)
    expect(body?.scope).toBe('agent')
    // Agents shouldn't see the platform-ops counts.
    expect(body?.sections?.duplicate_candidates?.count ?? 0).toBe(0)
    expect(body?.sections?.failed_imports?.count ?? 0).toBe(0)
    expect(body?.sections?.failing_webhooks?.count ?? 0).toBe(0)
  })

  it('agent stale_listings <= admin stale_listings', async () => {
    const [a, b] = await Promise.all([
      get('/api/dashboard/attention', ADMIN_JWT),
      get('/api/dashboard/attention', AGENT_JWT),
    ])
    const agentN = b.body?.sections?.stale_listings?.count ?? 0
    const adminN = a.body?.sections?.stale_listings?.count ?? 0
    expect(agentN).toBeLessThanOrEqual(adminN)
  })
})

describe.skipIf(!SHOULD_RUN)('/api/dashboard/listings-breakdown role scope', () => {
  it('agent total <= admin total', async () => {
    const [a, b] = await Promise.all([
      get('/api/dashboard/listings-breakdown', ADMIN_JWT),
      get('/api/dashboard/listings-breakdown', AGENT_JWT),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body.total).toBeLessThanOrEqual(a.body.total)
    expect(b.body.online.total).toBeLessThanOrEqual(a.body.online.total)
  })
})

describe.skipIf(!SHOULD_RUN)('/api/dashboard/trend user-scoped RPCs', () => {
  it('admin trend totals >= agent trend totals', async () => {
    const [a, b] = await Promise.all([
      get('/api/dashboard/trend?days=30', ADMIN_JWT),
      get('/api/dashboard/trend?days=30', AGENT_JWT),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const sum = (ds: any[], i: number) =>
      ds.reduce((acc, d) => acc + (Number(d?.data?.[i] ?? 0) || 0), 0)
    // Compare aggregate volumes across the 30-day window.
    const adminInq = sum(a.body.datasets ?? [], 0)
    const agentInq = sum(b.body.datasets ?? [], 0)
    expect(agentInq).toBeLessThanOrEqual(adminInq)
  })
})
