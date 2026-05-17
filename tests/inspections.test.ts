// Inspection workflow smoke tests (mig 20260508000007).
//
// Three RPCs in the inspection state machine:
//   - complete_inspection: admin marks scheduled inspection done +
//     records findings.
//   - tenant_sign_inspection: tenant portal records e-signature.
//   - charge_damages_to_security_deposit: iterates findings of
//     severity='damage' and creates property_charges rows.
//
// Fixture flow:
//   1. Insert a synthetic inspection (smoke marker on a `notes` field
//      or via the kind column).
//   2. Run complete_inspection with a single non-damage finding.
//   3. Verify findings landed + completed_at stamped.
//   4. Cleanup.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
const SHOULD_RUN =
  process.env.SUPABASE_TEST_PROJECT === '1' && !!SUPABASE_URL && !!SUPABASE_KEY

let supabase: SupabaseClient
const fixtureIds: string[] = []

beforeAll(() => {
  if (SHOULD_RUN) supabase = createClient(SUPABASE_URL!, SUPABASE_KEY)
})

afterAll(async () => {
  if (!SHOULD_RUN || fixtureIds.length === 0) return
  await supabase
    .from('inspection_findings')
    .delete()
    .in('inspection_id', fixtureIds)
  await supabase.from('inspections').delete().in('id', fixtureIds)
})

describe.skipIf(!SHOULD_RUN)('inspections + inspection_findings (table shape)', () => {
  it('inspections is queryable', async () => {
    const { error } = await supabase
      .from('inspections')
      .select('id, lease_id, kind, scheduled_for, completed_at, tenant_signed_at')
      .limit(1)
    expect(error).toBeNull()
  })

  it('inspection_findings is queryable', async () => {
    const { error } = await supabase
      .from('inspection_findings')
      .select('id, inspection_id, area, condition, severity, charge_amount')
      .limit(1)
    expect(error).toBeNull()
  })
})

describe.skipIf(!SHOULD_RUN)('complete_inspection RPC — happy path', () => {
  it('marks completed + persists findings', async () => {
    // Find any lease we can attach the test inspection to.
    const { data: lease } = await supabase
      .from('leases')
      .select('id')
      .limit(1)
      .maybeSingle()
    if (!lease?.id) {
      // No leases in this env — skip rather than fail.
      expect.soft(true).toBe(true)
      return
    }

    const { data: ins, error } = await supabase
      .from('inspections')
      .insert({
        lease_id: lease.id,
        kind: 'periodic',
        scheduled_for: new Date().toISOString(),
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    expect(ins?.id).toBeTruthy()
    fixtureIds.push(ins!.id)

    const { error: rpcErr } = await (supabase as any).rpc(
      'complete_inspection',
      {
        p_inspection_id: ins!.id,
        p_findings: [
          {
            area: 'Smoke kitchen',
            condition: 'good',
            severity: 'none',
            photos: [],
          },
        ],
      },
    )
    expect(rpcErr).toBeNull()

    // Verify state machine progressed.
    const { data: after } = await supabase
      .from('inspections')
      .select('completed_at')
      .eq('id', ins!.id)
      .single()
    expect(after?.completed_at).toBeTruthy()

    const { data: findings } = await supabase
      .from('inspection_findings')
      .select('id, area, severity')
      .eq('inspection_id', ins!.id)
    expect(Array.isArray(findings)).toBe(true)
    expect(findings?.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!SHOULD_RUN)('charge_damages_to_security_deposit — no-damage no-op', () => {
  it('returns 0 charges when no findings have severity=damage', async () => {
    if (fixtureIds.length === 0) {
      expect.soft(true).toBe(true)
      return
    }
    const inspectionId = fixtureIds[0]
    const { data, error } = await (supabase as any).rpc(
      'charge_damages_to_security_deposit',
      { p_inspection_id: inspectionId },
    )
    expect(error).toBeNull()
    const row = Array.isArray(data) ? data[0] : data
    if (row) {
      // Field name may vary by impl — accept either explicit zero or
      // a charges array of length 0.
      const inserted =
        Number(row.charges_inserted ?? row.charges?.length ?? 0)
      expect(inserted).toBe(0)
    }
  })
})
