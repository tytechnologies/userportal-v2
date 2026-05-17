#!/usr/bin/env node
// scripts/test-workflow-rpcs.mjs
//
// Exercises the deal workflow RPCs against the linked Supabase DB.
// Same env discipline as scripts/check-migrations.mjs.
//
// Usage:
//   pnpm test:workflow-rpcs
//
// Exit codes:
//   0  all assertions pass
//   1  one or more failed
//   2  configuration / connection error

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

function readEnv(name) {
  if (process.env[name]) return process.env[name]
  try {
    const envFile = fs.readFileSync(path.resolve('.env'), 'utf8')
    // Tolerate `KEY=VALUE` and `KEY = VALUE` styles (the repo .env uses the
    // spaced form). Strip optional surrounding quotes.
    const match = envFile.match(new RegExp(`^${name}\\s*=\\s*(.+?)\\s*$`, 'm'))
    return match ? match[1].replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const url = readEnv('SUPABASE_URL')
const key = readEnv('SUPABASE_SERVICE_KEY') || readEnv('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) {
  console.error('Missing SUPABASE_URL or service key')
  process.exit(2)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok ${msg}`) }
  else      { failed++; console.error(`  FAIL ${msg}`) }
}

async function setup() {
  // Create a throwaway deal owned by the first admin profile we can find.
  // Avoids RLS on the SELECT by using service-role.
  const { data: admin } = await sb.from('profiles').select('id').limit(1).maybeSingle()
  if (!admin?.id) throw new Error('No profiles available in DB')
  // Need a listing FK target.
  const { data: listing } = await sb.from('listings').select('id').limit(1).maybeSingle()
  if (!listing?.id) throw new Error('No listings available in DB')
  const { data: deal, error } = await sb.from('deals').insert({
    listing_id: listing.id,
    stage_key: 'documentation',
    title: '__test_workflow_rpcs_' + Date.now(),
    buyer_agent_user_id: admin.id,
    created_by: admin.id,
  }).select('id').single()
  if (error) throw error
  return deal.id
}

async function teardown(dealId) {
  // Cleanup is best-effort. CASCADE on deal_workflows -> deal_workflow_steps
  // and on deals -> deal_workflows handles the dependents.
  await sb.from('deals').delete().eq('id', dealId)
}

async function testHappyPathCondo(dealId) {
  console.log('\nsale_transfer_v1 / condo happy path')
  const { data: wfId, error } = await sb.rpc('deal_workflow_start', {
    p_deal_id: dealId,
    p_template_key: 'sale_transfer_v1',
    p_title_branch: 'condo',
    p_started_via: 'manual',
    p_envelope_id: null,
  })
  if (error) console.error('  RPC error:', error.message ?? error)
  assert(!error && wfId, 'deal_workflow_start returns workflow_id')
  if (!wfId) throw new Error('Cannot continue without workflow id')

  const { data: steps } = await sb.from('deal_workflow_steps')
    .select('step_index, status, key, phase')
    .eq('workflow_id', wfId).order('step_index')

  // 16 total; 3 skipped (land_only); 1 active (step_index=1, cgt_computation); rest locked.
  assert(steps.length === 16, '16 step rows snapshotted')
  assert(steps.filter(s => s.status === 'skipped').length === 3, '3 land_only steps skipped')
  assert(steps[0].status === 'active' && steps[0].key === 'cgt_computation',
         'first step is active = cgt_computation')

  // Advance through every non-skipped step.
  // We need a real documents row per step. Create one quickly per step.
  const { data: anyUser } = await sb.from('profiles').select('id').limit(1).maybeSingle()
  const nonSkipped = steps.filter(s => s.status !== 'skipped')
  for (let i = 0; i < nonSkipped.length; i++) {
    const stepRow = nonSkipped[i]
    // Refetch step id (we only selected step_index above)
    const { data: stepFull } = await sb.from('deal_workflow_steps')
      .select('id, attestation_text')
      .eq('workflow_id', wfId).eq('step_index', stepRow.step_index).maybeSingle()
    const { data: doc, error: docErr } = await sb.from('documents').insert({
      created_by: anyUser.id,
      document_type: `workflow_step_${stepRow.key ?? 'unknown'}`,
      s3_key: `test/${Date.now()}-${i}.pdf`,
      file_name: `step-${stepRow.step_index}.pdf`,
      deal_id: dealId,
    }).select('id').single()
    if (docErr) throw docErr
    const { data: nextId, error: advErr } = await sb.rpc('deal_workflow_advance', {
      p_step_id: stepFull.id,
      p_document_id: doc.id,
      p_attestation_signature: stepFull.attestation_text,
    })
    assert(!advErr, `advance step_index=${stepRow.step_index} succeeds`)
    if (i < nonSkipped.length - 1) {
      assert(nextId, `advance returns next step id (i=${i})`)
    } else {
      assert(nextId === null, 'final advance returns NULL')
    }
  }

  const { data: wf } = await sb.from('deal_workflows').select('status').eq('id', wfId).maybeSingle()
  assert(wf.status === 'completed', 'workflow status=completed')
}

async function testDuplicateStart(dealId) {
  console.log('\nduplicate start is rejected')
  const { error } = await sb.rpc('deal_workflow_start', {
    p_deal_id: dealId,
    p_template_key: 'sale_transfer_v1',
    p_title_branch: 'land',
    p_started_via: 'manual',
    p_envelope_id: null,
  })
  assert(!!error, 'second deal_workflow_start raises (workflow already exists)')
}

async function testLeaseFlow() {
  console.log('\nlease_v1 happy path')
  const dealId = await setup()
  try {
    const { data: wfId } = await sb.rpc('deal_workflow_start', {
      p_deal_id: dealId,
      p_template_key: 'lease_v1',
      p_title_branch: null,
      p_started_via: 'manual',
      p_envelope_id: null,
    })
    const { data: steps } = await sb.from('deal_workflow_steps')
      .select('step_index, status').eq('workflow_id', wfId).order('step_index')
    assert(steps.length === 3, 'lease has 3 steps')
    assert(steps.filter(s => s.status === 'skipped').length === 0, 'lease has no skipped steps')
    assert(steps[0].status === 'active', 'first lease step is active')
  } finally { await teardown(dealId) }
}

async function testAbandon() {
  console.log('\nabandon mid-flow')
  const dealId = await setup()
  try {
    const { data: wfId } = await sb.rpc('deal_workflow_start', {
      p_deal_id: dealId,
      p_template_key: 'sale_transfer_v1',
      p_title_branch: 'condo',
      p_started_via: 'manual',
      p_envelope_id: null,
    })
    const { error } = await sb.rpc('deal_workflow_abandon', {
      p_workflow_id: wfId, p_reason: 'wrong branch picked',
    })
    assert(!error, 'abandon succeeds')
    const { data: wf } = await sb.from('deal_workflows').select('status').eq('id', wfId).maybeSingle()
    assert(wf.status === 'abandoned', 'status=abandoned')

    const { error: abandonAgain } = await sb.rpc('deal_workflow_abandon', {
      p_workflow_id: wfId, p_reason: 'again',
    })
    assert(!!abandonAgain, 'second abandon is rejected (terminal)')
  } finally { await teardown(dealId) }
}

async function main() {
  console.log('Running deal workflow RPC tests...')
  const dealId = await setup()
  try {
    await testHappyPathCondo(dealId)
    await testDuplicateStart(dealId)
  } finally { await teardown(dealId) }

  await testLeaseFlow()
  await testAbandon()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
