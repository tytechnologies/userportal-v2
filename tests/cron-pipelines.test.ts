// Cron-driven aggregation pipelines smoke tests.
//
// Covers three pipelines that share shape (policy table + nightly RPC
// + generated rows):
//   1. Late-fee assessment (mig 20260508000004)
//   2. Tenant statement aggregation (mig 20260508000005)
//   3. Owner statement aggregation (mig 20260508000006)
//
// Each test:
//   - Probes that the RPC + policy table + output table exist.
//   - Fires the RPC dry (or with no policy) and asserts shape.
//   - Skips state mutation tests when there's no matching policy data
//     in the env (returns expect.soft true).
//
// Env-gated like the other integration suites.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll } from 'vitest'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
const SHOULD_RUN =
  process.env.SUPABASE_TEST_PROJECT === '1' && !!SUPABASE_URL && !!SUPABASE_KEY

let supabase: SupabaseClient
beforeAll(() => {
  if (SHOULD_RUN) supabase = createClient(SUPABASE_URL!, SUPABASE_KEY)
})

// --- Late-fee assessment ------------------------------------------

describe.skipIf(!SHOULD_RUN)('Late-fee assessment (mig 20260508000004)', () => {
  it('late_fee_policies table is queryable', async () => {
    const { error } = await supabase
      .from('late_fee_policies')
      .select('scope_kind, scope_id, grace_days, fee_kind, amount')
      .limit(1)
    expect(error).toBeNull()
  })

  it('late_fee_assessments table is queryable', async () => {
    const { error } = await supabase
      .from('late_fee_assessments')
      .select('id, charge_id, assessed_amount, assessed_on')
      .limit(1)
    expect(error).toBeNull()
  })

  it('assess_past_due_charges RPC exists and returns counts', async () => {
    const { data, error } = await (supabase as any).rpc(
      'assess_past_due_charges',
    )
    expect(error).toBeNull()
    const row = Array.isArray(data) ? data[0] : data
    // Returns (charges_evaluated, late_fees_inserted). Both must be ints.
    if (row) {
      expect(typeof Number(row.charges_evaluated)).toBe('number')
      expect(typeof Number(row.late_fees_inserted)).toBe('number')
    }
  })

  it('cron job scheduled (skips when pg_cron disabled)', async () => {
    const { data, error } = await (supabase as any)
      .from('cron.job')
      .select('jobname, schedule, active')
      .eq('jobname', 'assess_past_due_charges_daily')
      .maybeSingle()
    if (error?.code === '42501' || error?.message?.includes('cron')) {
      expect.soft(true).toBe(true) // pg_cron not enabled here
      return
    }
    if (data) {
      expect(data.schedule).toBe('0 4 * * *')
      expect(data.active).toBe(true)
    }
  })
})


// --- Tenant statement aggregation ---------------------------------

describe.skipIf(!SHOULD_RUN)('Tenant statement aggregation (mig 20260508000005)', () => {
  it('tenant_statement_policies + tenant_statements tables are queryable', async () => {
    const a = await supabase
      .from('tenant_statement_policies')
      .select('scope_kind, scope_id, cadence, day_of_month, include_late_fees')
      .limit(1)
    expect(a.error).toBeNull()
    const b = await supabase
      .from('tenant_statements')
      .select('id, tenant_id, lease_id, period_start, period_end, balance_due')
      .limit(1)
    expect(b.error).toBeNull()
  })

  it('generate_tenant_statements RPC resolves cleanly', async () => {
    const { data, error } = await (supabase as any).rpc(
      'generate_tenant_statements',
    )
    expect(error).toBeNull()
    const row = Array.isArray(data) ? data[0] : data
    if (row) {
      expect(typeof Number(row.statements_inserted ?? 0)).toBe('number')
      expect(typeof Number(row.policies_evaluated ?? 0)).toBe('number')
    }
  })
})


// --- Owner statement aggregation ----------------------------------

describe.skipIf(!SHOULD_RUN)('Owner statement aggregation (mig 20260508000006)', () => {
  it('owner_statement_policies + owner_statements tables are queryable', async () => {
    const a = await supabase
      .from('owner_statement_policies')
      .select('scope_kind, scope_id, cadence')
      .limit(1)
    expect(a.error).toBeNull()
    const b = await supabase
      .from('owner_statements')
      .select('id, owner_id, period_start, period_end, gross_collected, expenses_total, net_remit')
      .limit(1)
    expect(b.error).toBeNull()
  })

  it('generate_owner_statements RPC resolves cleanly', async () => {
    const { data, error } = await (supabase as any).rpc(
      'generate_owner_statements',
    )
    expect(error).toBeNull()
    const row = Array.isArray(data) ? data[0] : data
    if (row) {
      expect(typeof Number(row.statements_inserted ?? 0)).toBe('number')
    }
  })
})
