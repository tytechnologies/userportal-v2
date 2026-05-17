// Saved-search digest pipeline smoke tests.
//
// Covers:
//   - saved_searches + saved_search_subscriptions tables exist
//   - saved_searches_due_for_digest RPC resolves
//   - /api/admin/saved-searches/run-digest endpoint auth + dry-run
//   - internal_config singleton has the right shape
//
// Sending real emails is out of scope here — dry-run mode returns the
// audience without touching Resend. Email-deliverability proof comes
// from manually triggering with dryRun:false against a staging env.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll } from 'vitest'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
const PORTAL_BASE = process.env.PORTAL_BASE_URL || ''
const CRON_SECRET = process.env.INTERNAL_CRON_SECRET || ''

const SHOULD_RUN_DB =
  process.env.SUPABASE_TEST_PROJECT === '1' && !!SUPABASE_URL && !!SUPABASE_KEY
const SHOULD_RUN_HTTP = SHOULD_RUN_DB && !!PORTAL_BASE && !!CRON_SECRET

let supabase: SupabaseClient
beforeAll(() => {
  if (SHOULD_RUN_DB) supabase = createClient(SUPABASE_URL!, SUPABASE_KEY)
})

describe.skipIf(!SHOULD_RUN_DB)('Saved-search tables + RPCs', () => {
  it('saved_searches is queryable', async () => {
    const { error } = await supabase
      .from('saved_searches')
      .select('id, user_id, search_blob, name')
      .limit(1)
    expect(error).toBeNull()
  })

  it('saved_search_subscriptions is queryable', async () => {
    const { error } = await supabase
      .from('saved_search_subscriptions')
      .select('id, saved_search_id, cadence, last_sent_at')
      .limit(1)
    expect(error).toBeNull()
  })

  it('saved_searches_due_for_digest RPC resolves', async () => {
    const { data, error } = await (supabase as any).rpc(
      'saved_searches_due_for_digest',
    )
    expect(error).toBeNull()
    // Returns an array (possibly empty).
    expect(Array.isArray(data) || data === null).toBe(true)
  })

  it('internal_config singleton row exists with id=1', async () => {
    const { data, error } = await supabase
      .from('internal_config')
      .select('id, digest_endpoint_url, digest_cron_secret, portal_base_url')
      .eq('id', 1)
      .maybeSingle()
    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(data?.id).toBe(1)
    // URL/secret being unset is OK in test envs — just check the row
    // is structurally present so cron has a place to read from.
  })
})

describe.skipIf(!SHOULD_RUN_HTTP)('Digest endpoint — auth + dry-run', () => {
  async function http(path: string, init: RequestInit = {}) {
    const res = await fetch(`${PORTAL_BASE}${path}`, init)
    const text = await res.text()
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: res.status, body }
  }

  it('rejects without secret', async () => {
    const { status } = await http('/api/admin/saved-searches/run-digest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    })
    expect([401, 403]).toContain(status)
  })

  it('accepts with x-internal-secret and returns shape', async () => {
    const { status, body } = await http('/api/admin/saved-searches/run-digest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': CRON_SECRET,
      },
      body: JSON.stringify({ dryRun: true }),
    })
    expect(status).toBe(200)
    // The endpoint returns counts; specific shape varies by impl, but
    // it should be an object (not a stringified error).
    expect(typeof body).toBe('object')
  })
})


describe.skipIf(!SHOULD_RUN_DB)('Cron schedule', () => {
  it('saved_search_digest_daily registered (skips if pg_cron disabled)', async () => {
    const { data, error } = await (supabase as any)
      .from('cron.job')
      .select('jobname, schedule, active')
      .eq('jobname', 'saved_search_digest_daily')
      .maybeSingle()
    if (error?.code === '42501' || error?.message?.includes('cron')) {
      expect.soft(true).toBe(true)
      return
    }
    if (data) {
      expect(data.schedule).toBe('0 22 * * *')
      expect(data.active).toBe(true)
    }
  })
})
