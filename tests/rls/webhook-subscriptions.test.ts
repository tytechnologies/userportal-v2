// RLS suite: public.webhook_subscriptions + public.webhook_deliveries
//
// What's gated (migration 20260507000002_webhook_subscriptions):
//   - SELECT: webhooks.manage
//   - INSERT: webhooks.manage  (WITH CHECK)
//   - UPDATE: webhooks.manage  (USING + WITH CHECK)
//   - DELETE: webhooks.manage
//   - INSERT for webhook_deliveries is NOT granted to authenticated —
//     only the dispatcher (service-role) writes those.
//
// `webhooks.manage` is granted to role=admin in the role_permissions
// catalog. Agent + manager should hit deny, admin should pass.
//
// This suite is the canary for the broader RLS test harness — it
// exercises every primitive (signIn, scoped query, scoped insert,
// expectRlsDenied) so failures here usually mean the harness itself
// is broken before any policy changes need investigation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rlsEnvOrSkip } from './env'
import {
  setupRlsContext,
  expectRlsDenied,
  expectNoRows,
  type RlsContext,
} from './harness'

const env = rlsEnvOrSkip()

describe.skipIf(!env)('RLS · webhook_subscriptions', () => {
  // Each suite gets a unique runId so concurrent vitest workers don't
  // collide on the same auth users.
  const runId = `webhooks_${Date.now().toString(36)}`
  let ctx: RlsContext

  beforeAll(async () => {
    if (!env) return
    ctx = await setupRlsContext(env, { runId })
  }, 60_000)

  afterAll(async () => {
    if (ctx) await ctx.cleanup()
  })

  it('admin can list, insert, update, delete', async () => {
    const admin = await ctx.signInAs('admin')

    // List — empty or pre-seeded, both fine. We just want no error.
    const { error: selectErr } = await (admin as any)
      .from('webhook_subscriptions')
      .select('id')
      .limit(1)
    expect(selectErr).toBeNull()

    // Insert.
    const { data: created, error: insertErr } = await (admin as any)
      .from('webhook_subscriptions')
      .insert({
        display_name: `RLS test ${runId}`,
        url: 'https://example.test/webhook',
        event_kinds: ['inquiry.received'],
      })
      .select('id, enabled, signing_secret')
      .single()
    expect(insertErr).toBeNull()
    expect(created?.id).toBeTruthy()
    expect(created?.enabled).toBe(true)
    // Default is gen_random_bytes(32) → 64 hex chars.
    expect(created?.signing_secret).toMatch(/^[0-9a-f]{64}$/)

    // Update.
    const { error: updateErr } = await (admin as any)
      .from('webhook_subscriptions')
      .update({ enabled: false })
      .eq('id', created.id)
    expect(updateErr).toBeNull()

    // Delete (cleanup).
    const { error: deleteErr } = await (admin as any)
      .from('webhook_subscriptions')
      .delete()
      .eq('id', created.id)
    expect(deleteErr).toBeNull()
  })

  it('agent cannot select', async () => {
    const agent = await ctx.signInAs('agent_a')
    // PostgREST returns { data: [], error: null } on a SELECT denied
    // by RLS — empty result, not an error. expectNoRows captures that.
    await expectNoRows(
      (agent as any).from('webhook_subscriptions').select('id'),
      'agent webhook_subscriptions select',
    )
  })

  it('agent cannot insert', async () => {
    const agent = await ctx.signInAs('agent_a')
    await expectRlsDenied(
      (agent as any)
        .from('webhook_subscriptions')
        .insert({
          display_name: `agent_insert_${runId}`,
          url: 'https://example.test/agent',
        })
        .select(),
      'agent webhook_subscriptions insert',
    )
  })

  it('manager cannot select or insert (no webhooks.manage perm)', async () => {
    const mgr = await ctx.signInAs('manager')

    await expectNoRows(
      (mgr as any).from('webhook_subscriptions').select('id'),
      'manager webhook_subscriptions select',
    )

    await expectRlsDenied(
      (mgr as any)
        .from('webhook_subscriptions')
        .insert({
          display_name: `manager_insert_${runId}`,
          url: 'https://example.test/manager',
        })
        .select(),
      'manager webhook_subscriptions insert',
    )
  })

  it('webhook_deliveries: agent cannot select', async () => {
    const agent = await ctx.signInAs('agent_a')
    await expectNoRows(
      (agent as any).from('webhook_deliveries').select('id'),
      'agent webhook_deliveries select',
    )
  })
})
