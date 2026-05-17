// RLS suite: permission-gated RPCs for legacy_creators reconciliation.
//
// Migrations under test:
//   20260507000004_legacy_creators_reconcile         (initial)
//   20260507000005_legacy_creators_reconcile_ops_bypass  (session_user escape)
//   20260507000006_legacy_creators_column_guard      (column-existence guard)
//
// What we assert:
//   - admin (role + legacy.reconcile via role_permissions) can call
//     legacy_creators_summary without error.
//   - agent + manager are rejected with `permission denied` (42501).
//   - Column-existence guard returns no_legacy_columns: true on a DB
//     where the *_legacy columns aren't present, instead of erroring.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rlsEnvOrSkip } from './env'
import { setupRlsContext, type RlsContext } from './harness'

const env = rlsEnvOrSkip()

describe.skipIf(!env)('RPC · legacy_creators_summary', () => {
  const runId = `legacy_${Date.now().toString(36)}`
  let ctx: RlsContext

  beforeAll(async () => {
    if (!env) return
    ctx = await setupRlsContext(env, { runId })
  }, 60_000)

  afterAll(async () => {
    if (ctx) await ctx.cleanup()
  })

  it('admin gets a structured summary', async () => {
    const admin = await ctx.signInAs('admin')
    const { data, error } = await (admin as any).rpc(
      'legacy_creators_summary',
      { p_limit: 5, p_offset: 0 },
    )
    expect(error).toBeNull()
    // Shape assertions — works whether the legacy columns exist or not.
    expect(data).toBeTruthy()
    expect(data).toHaveProperty('counts')
    expect(data).toHaveProperty('suggestions')
    expect(data).toHaveProperty('total_suggestions')
    if (data.no_legacy_columns) {
      expect(data.suggestions).toEqual([])
      expect(data.total_suggestions).toBe(0)
    } else {
      expect(Array.isArray(data.suggestions)).toBe(true)
    }
  })

  it('agent is rejected with 42501 / permission denied', async () => {
    const agent = await ctx.signInAs('agent_a')
    const { error } = await (agent as any).rpc('legacy_creators_summary', {
      p_limit: 5,
      p_offset: 0,
    })
    expect(error).toBeTruthy()
    const code = (error?.code || error?.statusCode || '').toString()
    const msg = (error?.message || '').toLowerCase()
    expect(code === '42501' || msg.includes('permission denied')).toBe(true)
  })

  it('manager is rejected (no legacy.reconcile in role_permissions)', async () => {
    const mgr = await ctx.signInAs('manager')
    const { error } = await (mgr as any).rpc('legacy_creators_summary', {
      p_limit: 5,
      p_offset: 0,
    })
    expect(error).toBeTruthy()
    const msg = (error?.message || '').toLowerCase()
    expect(msg).toMatch(/permission denied|legacy\.reconcile/)
  })

  it('apply RPC rejects invalid target_column for non-admins', async () => {
    const agent = await ctx.signInAs('agent_a')
    const { error } = await (agent as any).rpc('legacy_creators_apply', {
      p_listing_id: 1,
      p_target_column: 'created_by',
      p_profile_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(error).toBeTruthy()
    // The permission check fires BEFORE the target_column validation,
    // so we expect 42501 here regardless of the target_column value.
    const code = (error?.code || error?.statusCode || '').toString()
    expect(code === '42501' || (error?.message || '').toLowerCase().includes('permission')).toBe(true)
  })
})
