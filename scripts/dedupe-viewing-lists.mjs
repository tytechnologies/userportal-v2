#!/usr/bin/env node
// scripts/dedupe-viewing-lists.mjs
//
// Dedupes viewing-list rows in public.documents.
//
// Three dedupe modes:
//   --by=s3_key       Default. Same physical S3 object referenced twice.
//                     Unambiguous — multiple documents.id pointing at the
//                     same blob. Keep policy: oldest created_at wins.
//   --by=file_name    Same `(created_by, file_name)`. Catches re-uploads
//                     where the file content is identical (file_name
//                     includes the date) but a new S3 key was minted.
//   --by=client       Same `(created_by, contact_id, listing_id)` within
//                     a 24h window. Catches near-simultaneous duplicate
//                     generations for the same broker/contact/listing
//                     where the file_name differs (e.g. by seconds).
//
// Usage:
//   pnpm dedupe:viewing-lists                       # dry-run, s3_key mode
//   pnpm dedupe:viewing-lists --by=file_name        # dry-run, file_name mode
//   pnpm dedupe:viewing-lists --by=client           # dry-run, client mode
//   pnpm dedupe:viewing-lists --apply               # delete s3_key dupes
//   pnpm dedupe:viewing-lists --by=file_name --apply
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY).
//
// Exit codes:
//   0  scan completed.
//   1  delete failed.
//   2  configuration / connection error.

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

function readEnv(name) {
  if (process.env[name]) return process.env[name]
  try {
    const envFile = fs.readFileSync(path.resolve('.env'), 'utf8')
    const match = envFile.match(new RegExp(`^${name}\\s*=\\s*(.+?)\\s*$`, 'm'))
    return match ? match[1].replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const asJson = args.includes('--json')
const byArg = args.find((a) => a.startsWith('--by='))
const mode = (byArg ? byArg.slice('--by='.length) : 's3_key')
if (!['s3_key', 'file_name', 'client'].includes(mode)) {
  console.error(`Unknown --by=${mode}. Valid: s3_key, file_name, client`)
  process.exit(2)
}

const url = readEnv('SUPABASE_URL')
const key = readEnv('SUPABASE_SERVICE_KEY') || readEnv('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) {
  console.error('Missing SUPABASE_URL or service key')
  process.exit(2)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

function log(...args) { if (!asJson) console.log(...args) }

// Within --by=client, two rows are duplicates only if their created_at
// is within this many ms of each other. Without a window, every list
// the same broker ever made for the same contact would collapse.
const CLIENT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

function keyOf(row) {
  if (mode === 's3_key') return row.s3_key || null
  if (mode === 'file_name') {
    if (!row.created_by || !row.file_name) return null
    return `${row.created_by}::${row.file_name}`
  }
  // client mode — bucket by (created_by, contact_id, listing_id, day).
  // day-bucket keeps two months-apart generations from collapsing while
  // catching same-day re-renders. Requires at least one of contact_id /
  // listing_id to be set; without either, the bucket would collapse
  // legitimately-distinct viewing lists from the same broker on the
  // same day (the client identity lives only in the file_name).
  if (!row.created_by) return null
  if (row.contact_id == null && row.listing_id == null) return null
  const day = new Date(row.created_at)
  if (Number.isNaN(day.getTime())) return null
  const bucket = Math.floor(day.getTime() / CLIENT_DEDUPE_WINDOW_MS)
  return `${row.created_by}::c=${row.contact_id ?? ''}::l=${row.listing_id ?? ''}::d=${bucket}`
}

async function main() {
  log(`Scanning public.documents for viewing_list duplicates by ${mode}…`)

  const { data: rows, error } = await sb
    .from('documents')
    .select('id, s3_key, file_name, created_by, created_at, deal_id, contact_id, listing_id')
    .eq('document_type', 'viewing_list')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Query failed:', error.message)
    process.exit(2)
  }
  if (!rows || rows.length === 0) {
    log('No viewing_list rows found.')
    if (asJson) console.log(JSON.stringify({ scanned: 0, duplicate_groups: 0, deleted: 0 }))
    return
  }

  /** @type {Record<string, typeof rows>} */
  const byKey = {}
  let nullKeyCount = 0
  for (const r of rows) {
    const k = keyOf(r)
    if (!k) { nullKeyCount += 1; continue }
    if (!byKey[k]) byKey[k] = []
    byKey[k].push(r)
  }

  const dupGroups = Object.entries(byKey).filter(([, group]) => group.length > 1)

  log(`Scanned: ${rows.length} viewing_list rows`)
  log(`Rows with null dedup key (skipped): ${nullKeyCount}`)
  log(`Duplicate groups (>=2 rows sharing key): ${dupGroups.length}`)

  if (dupGroups.length === 0) {
    if (asJson) console.log(JSON.stringify({ mode, scanned: rows.length, duplicate_groups: 0, deleted: 0 }))
    return
  }

  const plan = dupGroups.map(([k, group]) => {
    const keep = group[0]
    const drop = group.slice(1)
    return {
      dedup_key: k,
      keep_id: keep.id,
      keep_created_at: keep.created_at,
      keep_file_name: keep.file_name,
      drop_ids: drop.map((r) => r.id),
      drop_file_names: drop.map((r) => r.file_name),
      drop_count: drop.length,
    }
  })

  const totalDrop = plan.reduce((n, p) => n + p.drop_count, 0)
  log(`Rows to delete: ${totalDrop}`)
  for (const p of plan) {
    log(`  ${p.dedup_key}`)
    log(`    keep   ${p.keep_id}  ${p.keep_file_name}  (${p.keep_created_at})`)
    for (let i = 0; i < p.drop_ids.length; i++) {
      log(`    drop   ${p.drop_ids[i]}  ${p.drop_file_names[i]}`)
    }
  }

  if (!apply) {
    log('\nDry run only. Re-run with --apply to delete.')
    if (asJson) console.log(JSON.stringify({
      mode, scanned: rows.length, duplicate_groups: dupGroups.length,
      would_delete: totalDrop, plan,
    }))
    return
  }

  log('\nApplying deletes…')
  const dropIds = plan.flatMap((p) => p.drop_ids)
  const { error: delError, count } = await sb
    .from('documents')
    .delete({ count: 'exact' })
    .in('id', dropIds)
  if (delError) {
    console.error('Delete failed:', delError.message)
    process.exit(1)
  }
  log(`Deleted ${count ?? dropIds.length} rows.`)
  if (asJson) console.log(JSON.stringify({
    mode, scanned: rows.length, duplicate_groups: dupGroups.length,
    deleted: count ?? dropIds.length, plan,
  }))
}

main().catch((e) => { console.error(e); process.exit(2) })
