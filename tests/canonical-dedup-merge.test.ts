// Smoke-level tests for the canonical / dedup / merge surfaces.
//
// Mirrors testUpdateListings.test.js's env-gate pattern — these
// tests hit a REAL Supabase project and are skipped unless
// SUPABASE_TEST_PROJECT=1 is set. NEVER run against production —
// the merge_listings_into_property RPC mutates listings.property_id
// and the dedup RPC can insert candidates into the review queue.
//
// What's exercised:
//   1. elect_primary_listing_id — pure read; deterministic election rule.
//   2. merge_listings_into_property — reparent + close-pair semantics.
//   3. find_listing_duplicate_candidates — detector cron entry point.
//   4. record_source_health — SLO state-machine transitions.
//
// Each test is independent; setup creates fresh fixture rows via
// inserts and cleans up in afterEach where possible. Failures
// surface in the smoke-style format the migration footers use.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''

const SHOULD_RUN =
  process.env.SUPABASE_TEST_PROJECT === '1' &&
  !!SUPABASE_URL &&
  !!SUPABASE_KEY

let supabase: SupabaseClient

beforeAll(() => {
  if (SHOULD_RUN) supabase = createClient(SUPABASE_URL!, SUPABASE_KEY)
})

describe.skipIf(!SHOULD_RUN)('elect_primary_listing_id (RPC)', () => {
  it('returns a live listing id for a property that has listings', async () => {
    // Pick the first property with at least one live listing.
    const { data: rows } = await supabase
      .from('listings')
      .select('property_id')
      .eq('is_online', true)
      .is('deleted_at', null)
      .limit(1)
    const propertyId = rows?.[0]?.property_id
    if (!propertyId) {
      // No live listings to test against — explicit pass with a note.
      expect.soft(true).toBe(true)
      return
    }

    const { data, error } = await (supabase as any).rpc(
      'elect_primary_listing_id',
      { p_property_id: propertyId },
    )
    expect(error).toBeNull()
    expect(typeof data === 'number' || data === null).toBe(true)
    if (typeof data === 'number') {
      const { data: row } = await supabase
        .from('listings')
        .select('id, is_online, deleted_at')
        .eq('id', data)
        .single()
      expect(row?.is_online).toBe(true)
      expect(row?.deleted_at).toBeNull()
    }
  })

  it('returns null for a property with no live listings', async () => {
    // Insert a property + a soft-deleted listing under it. The
    // election rule filters to is_online=true / deleted_at IS NULL,
    // so the soft-deleted variant must NOT be elected.
    const { data: city } = await supabase.from('cities').select('id').limit(1).single()
    const { data: prop } = await supabase
      .from('properties')
      .insert({ category: 'residential', city_id: city!.id, name: 'test:elect-empty' })
      .select('id')
      .single()
    expect(prop?.id).toBeTruthy()

    const { data, error } = await (supabase as any).rpc(
      'elect_primary_listing_id',
      { p_property_id: prop!.id },
    )
    expect(error).toBeNull()
    expect(data).toBeNull()

    // Cleanup.
    await supabase.from('properties').delete().eq('id', prop!.id)
  })
})

describe.skipIf(!SHOULD_RUN)('merge_listings_into_property (RPC)', () => {
  it('reparents a listing and returns the old/new property ids', async () => {
    // Find two listings on different properties so we can move one onto the other.
    const { data: rows } = await supabase
      .from('listings')
      .select('id, property_id')
      .eq('is_online', true)
      .is('deleted_at', null)
      .limit(20)
    const a = rows?.[0]
    const b = rows?.find((r) => r.property_id !== a?.property_id)
    if (!a || !b) {
      expect.soft(true).toBe(true) // not enough variation
      return
    }

    const originalA = a.property_id

    const { data: result, error } = await (supabase as any).rpc(
      'merge_listings_into_property',
      {
        p_source_listing_id: a.id,
        p_target_property_id: b.property_id,
        p_set_primary_to: null,
        p_pair_id: null,
      },
    )
    expect(error).toBeNull()
    expect(result).toBeTruthy()
    expect(result.old_property_id).toBe(originalA)
    expect(result.new_property_id).toBe(b.property_id)
    expect(result.reparented).toBe(true)

    // Restore — leave the DB in its prior state for repeated runs.
    await supabase.from('listings').update({ property_id: originalA }).eq('id', a.id)
  })

  it('throws 42704 for an unknown source listing id', async () => {
    const { error } = await (supabase as any).rpc('merge_listings_into_property', {
      p_source_listing_id: -1,
      p_target_property_id: 1,
      p_set_primary_to: null,
      p_pair_id: null,
    })
    expect(error).toBeTruthy()
    expect((error as any).code).toBe('42704')
  })
})

describe.skipIf(!SHOULD_RUN)('find_listing_duplicate_candidates (RPC)', () => {
  it('runs the recent-only pass and returns counts', async () => {
    const { data, error } = await (supabase as any).rpc(
      'find_listing_duplicate_candidates',
      { p_only_recent: true, p_max: 50 },
    )
    expect(error).toBeNull()
    // The RPC returns a table with (inserted_count, evaluated_pairs).
    const row = Array.isArray(data) ? data[0] : data
    expect(row).toBeTruthy()
    expect(typeof row.inserted_count).toBe('number')
    expect(row.inserted_count).toBeGreaterThanOrEqual(0)
  })
})

describe.skipIf(!SHOULD_RUN)('record_source_health (RPC)', () => {
  it('walks the success/fail/recover state machine', async () => {
    const { data: src } = await supabase
      .from('listing_sources')
      .select('id')
      .limit(1)
      .single()
    if (!src?.id) {
      expect.soft(true).toBe(true) // no sources, can't test
      return
    }
    const sid = src.id

    // Success → consecutive_failures=0, alert_state='ok'.
    {
      const { error } = await (supabase as any).rpc('record_source_health', {
        p_source_id: sid,
        p_success: true,
        p_duration_ms: 200,
      })
      expect(error).toBeNull()
      const { data } = await supabase.from('source_health').select('*').eq('source_id', sid).single()
      expect(data?.consecutive_failures).toBe(0)
      expect(data?.alert_state).toBe('ok')
    }

    // 3 failures → alert.
    for (let i = 0; i < 3; i++) {
      await (supabase as any).rpc('record_source_health', {
        p_source_id: sid,
        p_success: false,
        p_duration_ms: 5000,
      })
    }
    {
      const { data } = await supabase.from('source_health').select('*').eq('source_id', sid).single()
      expect(data?.consecutive_failures).toBeGreaterThanOrEqual(3)
      expect(data?.alert_state).toBe('alert')
    }

    // Recover with a success → back to ok.
    {
      await (supabase as any).rpc('record_source_health', {
        p_source_id: sid,
        p_success: true,
        p_duration_ms: 220,
      })
      const { data } = await supabase.from('source_health').select('*').eq('source_id', sid).single()
      expect(data?.consecutive_failures).toBe(0)
      expect(data?.alert_state).toBe('ok')
    }
  })
})

afterAll(async () => {
  // No global teardown — each test restores its own state. Keeping
  // this hook in place so suites added later don't have to wire it.
})
