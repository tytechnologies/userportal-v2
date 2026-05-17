#!/usr/bin/env node
// scripts/check-migrations.mjs
//
// Reports which migrations in supabase/migrations/ have NOT been applied
// to the linked Supabase project. Catches the class of bug where a
// migration sits in the repo but never ran in prod — recent examples:
//   - 20260509000008_fix_transaction_rooms_rls_recursion (RLS recursion
//     errors hung room reads until applied)
//   - 20260429000003 / 000004 (contact + city/barangay denorm cleanup;
//     joins return null city/contact names if not applied)
//
// Usage:
//   pnpm check:migrations            # uses SUPABASE_URL + service key
//   pnpm check:migrations --json     # machine-readable output
//
// Required env (read from .env via dotenv-style fallback):
//   SUPABASE_URL                     — project URL
//   SUPABASE_SERVICE_KEY  (or)       — preferred name
//   SUPABASE_SERVICE_ROLE_KEY        — canonical Supabase dashboard name
//
// Exit code:
//   0  every repo migration is applied (or older than the earliest
//      applied migration, which can happen when re-baselining)
//   1  one or more repo migrations are missing on the live DB
//   2  configuration / connection error
//
// Why we read supabase_migrations.schema_migrations directly rather
// than shelling out to `supabase migration list`: the Supabase CLI
// requires a linked project + access token, which CI rarely has.
// The service-role key is already in the deployment env, so we use it.

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')

function readEnv(name) {
  if (process.env[name]) return process.env[name]
  // Tolerate a missing .env (CI typically has env vars injected via the
  // runner). Reading the file is a convenience for local runs only.
  try {
    const envFile = fs.readFileSync(path.resolve('.env'), 'utf8')
    const match = envFile.match(new RegExp(`^${name}=(.+)$`, 'm'))
    return match ? match[1].replace(/^["']|["']$/g, '').trim() : ''
  } catch {
    return ''
  }
}

const SUPABASE_URL = readEnv('SUPABASE_URL')
const SERVICE_KEY =
  readEnv('SUPABASE_SERVICE_KEY') ||
  readEnv('SUPABASE_SERVICE_ROLE_KEY') ||
  readEnv('NUXT_SUPABASE_SERVICE_KEY')

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    '[check-migrations] missing SUPABASE_URL or service-role key in env.\n' +
    '  Set SUPABASE_URL + SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) in .env or the shell.',
  )
  process.exit(2)
}

// List repo migrations.
const MIGRATIONS_DIR = path.resolve('supabase', 'migrations')
let repoMigrations
try {
  repoMigrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/i, ''))
    .sort()
} catch (err) {
  console.error(`[check-migrations] could not read ${MIGRATIONS_DIR}: ${err.message}`)
  process.exit(2)
}

if (repoMigrations.length === 0) {
  console.error(`[check-migrations] no migrations found in ${MIGRATIONS_DIR}`)
  process.exit(2)
}

// Read applied migrations via PostgREST. supabase_migrations.schema_migrations
// is the standard table the Supabase CLI writes to; the version column
// holds the filename stem (e.g. "20260509000008_fix_...").
const url = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/schema_migrations?select=version&order=version.asc`

let appliedRows
try {
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'accept-profile': 'supabase_migrations',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(
      `[check-migrations] PostgREST returned ${res.status} when reading schema_migrations.\n` +
      `  Body: ${body.slice(0, 400)}\n` +
      `  Hint: confirm the service-role key has access to the supabase_migrations schema, and the project URL is correct.`,
    )
    process.exit(2)
  }
  appliedRows = await res.json()
} catch (err) {
  console.error(`[check-migrations] network error: ${err.message}`)
  process.exit(2)
}

const appliedSet = new Set(appliedRows.map((r) => r.version))

// Anything older than the earliest applied is treated as already baked
// into the live schema (re-baselined or pre-migration-tooling era).
// We only fail on migrations that are NEWER than the earliest applied
// and that the live DB hasn't run.
const earliestApplied = appliedRows[0]?.version ?? null
const pending = repoMigrations.filter((m) => {
  if (appliedSet.has(m)) return false
  if (earliestApplied && m < earliestApplied) return false
  return true
})

if (asJson) {
  console.log(JSON.stringify({
    repo_count:    repoMigrations.length,
    applied_count: appliedRows.length,
    pending_count: pending.length,
    pending,
  }, null, 2))
} else {
  console.log(`Repo migrations:    ${repoMigrations.length}`)
  console.log(`Applied (live):     ${appliedRows.length}`)
  console.log(`Pending:            ${pending.length}`)
  if (pending.length > 0) {
    console.log('')
    console.log('Pending migrations (NOT applied on the linked project):')
    for (const m of pending) console.log(`  - ${m}`)
    console.log('')
    console.log('Apply with: `supabase db push` (from a linked clone)')
  }
}

process.exit(pending.length > 0 ? 1 : 0)
