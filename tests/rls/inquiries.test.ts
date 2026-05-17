// RLS suite: public.inquiries
//
// Migration under test: 20260502000006_inquiries
//
// Policy summary:
//   - INSERT: NOT granted to authenticated (server-side service-role
//     only via /api/public/inquiries).
//   - SELECT: assigned_user_id = auth.uid() OR has inquiries.read.team /
//     inquiries.read.all.
//
// We assert the negatives + the assigned-agent positive using a
// service-role-seeded inquiry row with assigned_user_id pointing at
// agent_a. agent_b should NOT see it; agent_a should.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rlsEnvOrSkip } from './env'
import {
  setupRlsContext,
  expectRlsDenied,
  expectNoRows,
  type RlsContext,
} from './harness'

const env = rlsEnvOrSkip()

describe.skipIf(!env)('RLS · inquiries', () => {
  const runId = `inq_${Date.now().toString(36)}`
  let ctx: RlsContext
  let seededInquiryId: string | null = null
  let seededListingId: number | null = null

  beforeAll(async () => {
    if (!env) return
    ctx = await setupRlsContext(env, { runId })

    // Seed: a listing owned by agent_a, then an inquiry assigned to
    // agent_a. Pick the smallest possible payload — the goal is to
    // create a row inquiries can target, not exercise the listings
    // table itself.
    const { data: listing, error: listingErr } = await (ctx.serviceClient as any)
      .from('listings')
      .insert({
        title: `RLS test listing ${runId}`,
        created_by: ctx.users.agent_a.id,
        is_online: true,
        sale_price: 1,
        for_sale: true,
      })
      .select('id')
      .single()
    if (listingErr || !listing) {
      throw new Error(`Seed listing failed: ${listingErr?.message || 'unknown'}`)
    }
    seededListingId = listing.id

    const { data: inquiry, error: inquiryErr } = await (ctx.serviceClient as any)
      .from('inquiries')
      .insert({
        listing_id: seededListingId,
        assigned_user_id: ctx.users.agent_a.id,
        sender_name: `Visitor ${runId}`,
        sender_email: `visitor+${runId}@example.test`,
        message: 'RLS test inquiry',
        source: 'rls-test',
      })
      .select('id')
      .single()
    if (inquiryErr || !inquiry) {
      throw new Error(`Seed inquiry failed: ${inquiryErr?.message || 'unknown'}`)
    }
    seededInquiryId = inquiry.id
  }, 60_000)

  afterAll(async () => {
    // Best-effort cleanup. Listing CASCADE delete pulls the inquiry too.
    if (seededListingId) {
      await (ctx.serviceClient as any)
        .from('listings')
        .delete()
        .eq('id', seededListingId)
        .then(() => undefined)
        .catch(() => undefined)
    }
    if (ctx) await ctx.cleanup()
  })

  it('assigned agent sees their own inquiry', async () => {
    const agentA = await ctx.signInAs('agent_a')
    const { data, error } = await (agentA as any)
      .from('inquiries')
      .select('id, assigned_user_id')
      .eq('id', seededInquiryId!)
      .maybeSingle()
    expect(error).toBeNull()
    expect(data?.id).toBe(seededInquiryId)
    expect(data?.assigned_user_id).toBe(ctx.users.agent_a.id)
  })

  it('different agent cannot see another agent\'s inquiry', async () => {
    const agentB = await ctx.signInAs('agent_b')
    await expectNoRows(
      (agentB as any)
        .from('inquiries')
        .select('id')
        .eq('id', seededInquiryId!),
      'agent_b inquiries select',
    )
  })

  it('authenticated user cannot insert directly (server-only path)', async () => {
    const agent = await ctx.signInAs('agent_a')
    await expectRlsDenied(
      (agent as any)
        .from('inquiries')
        .insert({
          listing_id: seededListingId!,
          sender_name: 'forge attempt',
          message: 'should fail',
        })
        .select(),
      'agent inquiries direct insert',
    )
  })
})
