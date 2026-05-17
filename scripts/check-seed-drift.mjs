#!/usr/bin/env node
// scripts/check-seed-drift.mjs
//
// Data-level drift check against the canonical seed.sql in the repo
// root. Companion to scripts/check-reference-drift.mjs (schema-level
// drift); this script catches DATA drift — e.g.:
//   - production property_types.id slugs mutated after seed
//   - missing rows that the app code expects (a category disappears
//     from the dropdown silently)
//   - extra rows in production that aren't part of the canonical set
//   - PK-keyed field values that diverge (city name changed)
//
// Tables checked are EXACTLY the 9 in the reference seed:
//   amenities, barangays, cities, designations, developers,
//   property_types, provinces, search_result_pages, zonal_values
//
// For each table:
//   1. Parse the INSERT statement out of seed.sql.
//   2. Pull the same rows from the live DB (one fetch).
//   3. Diff by primary key. Report:
//        missing_in_prod    — seed has row, prod doesn't
//        extra_in_prod      — prod has row, seed doesn't
//        diverged           — same PK, but key fields differ
//
// Usage:
//   pnpm check:seed-drift                # uses .env config
//   pnpm check:seed-drift --json         # machine-readable
//   pnpm check:seed-drift --table cities # one table only
//   pnpm check:seed-drift --table property_types --strict
//                                        # any drift fails (exit 1)
//
// Env (read from .env or process.env):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY  or  SUPABASE_SERVICE_ROLE_KEY
//
// Exit codes:
//   0  no drift detected
//   1  drift detected (warnings or errors — use --strict to fail
//      on warnings too)
//   2  configuration / connection / parse error

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const strict = args.includes('--strict')
const tableFlag = args.findIndex((a) => a === '--table')
const onlyTable = tableFlag >= 0 ? args[tableFlag + 1] : null

const SEED_PATH = path.resolve('../seed.sql')

// --------------------------------------------------------------------
// Tables we check + which columns matter for the diff. Fields beyond
// these may legitimately differ between dev and seed (e.g. coord may
// be backfilled post-seed); the script focuses on identity + the
// fields the application code reads.
// --------------------------------------------------------------------
const TABLES = {
  property_types: {
    pk: 'id',
    columns: ['id', 'display_name', 'property_category', 'is_building'],
  },
  designations: {
    pk: 'id',
    columns: ['id', 'display_name'],
  },
  amenities: {
    pk: 'id',
    columns: ['id', 'name'],
  },
  developers: {
    pk: 'id',
    columns: ['id', 'name', 'slug'],
  },
  provinces: {
    pk: 'id',
    columns: ['id', 'slug', 'name'],
  },
  cities: {
    pk: 'id',
    columns: ['id', 'province_id', 'slug', 'name'],
  },
  barangays: {
    pk: 'id',
    columns: ['id', 'city_id', 'slug', 'name'],
  },
  search_result_pages: {
    pk: 'id',
    columns: ['id', 'url_path'],
  },
  zonal_values: {
    pk: 'property_id',
    columns: ['property_id'],
  },
}

// --------------------------------------------------------------------
// Env
// --------------------------------------------------------------------
function readEnv(name) {
  if (process.env[name]) return process.env[name]
  try {
    const envFile = fs.readFileSync(path.resolve('.env'), 'utf8')
    const match = envFile.match(new RegExp(`^${name}=(.+)$`, 'm'))
    return match ? match[1].replace(/^["']|["']$/g, '').trim() : ''
  } catch {
    return ''
  }
}

const SUPABASE_URL = readEnv('SUPABASE_URL')
const SERVICE_KEY = readEnv('SUPABASE_SERVICE_KEY') || readEnv('SUPABASE_SERVICE_ROLE_KEY')

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('seed-drift: missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
  process.exit(2)
}

// --------------------------------------------------------------------
// Parse seed.sql
// --------------------------------------------------------------------
//
// Format of each section:
//   INSERT INTO "public"."<table>" ("col1", "col2", ...) OVERRIDING SYSTEM VALUE VALUES
//       (val, val, ...),
//       (val, val, ...),
//       ...
//       (val, val, ...);
//
// Values are SQL literals: integers, NULL, single-quoted strings (with
// doubled '' for escapes). No nested arrays or geometry literals in
// the columns we care about.

function parseSqlValueLine(line) {
  // Strip leading '(' and trailing '),' or ');'.
  const inner = line.trim().replace(/^\(/, '').replace(/\)[,;]?$/, '')
  const out = []
  let i = 0
  while (i < inner.length) {
    // Skip leading whitespace.
    while (i < inner.length && inner[i] === ' ') i++
    if (inner[i] === "'") {
      // Single-quoted string with '' escape for inner quotes.
      let buf = ''
      i++ // skip opening
      while (i < inner.length) {
        if (inner[i] === "'") {
          if (inner[i + 1] === "'") {
            buf += "'"
            i += 2
            continue
          }
          i++ // skip closing
          break
        }
        buf += inner[i]
        i++
      }
      out.push(buf)
    } else {
      // Read until next unquoted comma.
      let buf = ''
      while (i < inner.length && inner[i] !== ',') {
        buf += inner[i]
        i++
      }
      const trimmed = buf.trim()
      if (trimmed.toUpperCase() === 'NULL') out.push(null)
      else if (/^-?\d+$/.test(trimmed)) out.push(parseInt(trimmed, 10))
      else if (/^-?\d+\.\d+$/.test(trimmed)) out.push(parseFloat(trimmed))
      else if (trimmed === 'true') out.push(true)
      else if (trimmed === 'false') out.push(false)
      else out.push(trimmed)
    }
    // Skip trailing comma.
    while (i < inner.length && inner[i] === ',') i++
    while (i < inner.length && inner[i] === ' ') i++
  }
  return out
}

function parseSeedSection(seedText, table) {
  // Find the INSERT INTO "public"."<table>" block.
  const headerRe = new RegExp(
    `INSERT\\s+INTO\\s+"public"\\."${table}"\\s*\\(([^)]+)\\)[^V]*VALUES\\s*`,
    'i',
  )
  const headerMatch = headerRe.exec(seedText)
  if (!headerMatch) return null

  const cols = headerMatch[1]
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, ''))
  const start = headerMatch.index + headerMatch[0].length

  // Walk forward line-by-line until we hit a line ending with `;`.
  const rest = seedText.slice(start)
  const endIdx = rest.indexOf(';')
  if (endIdx < 0) return null
  const valuesBlock = rest.slice(0, endIdx)

  const rows = []
  const lines = valuesBlock.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('(')) continue
    const values = parseSqlValueLine(trimmed)
    const row = {}
    cols.forEach((col, i) => {
      row[col] = values[i] !== undefined ? values[i] : null
    })
    rows.push(row)
  }
  return { columns: cols, rows }
}

// --------------------------------------------------------------------
// DB fetch
// --------------------------------------------------------------------

async function fetchProdRows(table, columns) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${columns.join(',')}`
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
      Prefer: 'count=exact',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`fetch ${table}: ${res.status} ${body.slice(0, 200)}`)
  }
  return (await res.json()) || []
}

// --------------------------------------------------------------------
// Diff
// --------------------------------------------------------------------

function diffRows(seedRows, prodRows, pk, columns) {
  const seedByKey = new Map(seedRows.map((r) => [String(r[pk]), r]))
  const prodByKey = new Map(prodRows.map((r) => [String(r[pk]), r]))

  const missing_in_prod = []
  const extra_in_prod = []
  const diverged = []

  for (const [k, seed] of seedByKey.entries()) {
    if (!prodByKey.has(k)) {
      missing_in_prod.push(seed)
      continue
    }
    const prod = prodByKey.get(k)
    const fields = []
    for (const col of columns) {
      if (col === pk) continue
      const a = seed[col]
      const b = prod[col]
      // Loose-equal so 1 vs "1" / true vs "true" don't false-positive
      // — PostgREST sometimes returns numeric/boolean as strings on
      // jsonb-leaking views.
      if (String(a ?? '') !== String(b ?? '')) {
        fields.push({ column: col, seed: a, prod: b })
      }
    }
    if (fields.length > 0) diverged.push({ pk: k, fields })
  }

  for (const [k, prod] of prodByKey.entries()) {
    if (!seedByKey.has(k)) extra_in_prod.push(prod)
  }

  return { missing_in_prod, extra_in_prod, diverged }
}

// --------------------------------------------------------------------
// Run
// --------------------------------------------------------------------

let seedText
try {
  seedText = fs.readFileSync(SEED_PATH, 'utf8')
} catch (err) {
  console.error(`seed-drift: cannot read ${SEED_PATH} — ${err.message}`)
  process.exit(2)
}

const targets = onlyTable
  ? Object.fromEntries(Object.entries(TABLES).filter(([k]) => k === onlyTable))
  : TABLES

if (Object.keys(targets).length === 0) {
  console.error(`seed-drift: unknown --table "${onlyTable}". Known: ${Object.keys(TABLES).join(', ')}`)
  process.exit(2)
}

const results = []
let totalIssues = 0

for (const [table, cfg] of Object.entries(targets)) {
  const section = parseSeedSection(seedText, table)
  if (!section) {
    results.push({
      table,
      status: 'skipped',
      reason: 'no INSERT block found in seed.sql',
    })
    continue
  }

  let prodRows
  try {
    prodRows = await fetchProdRows(table, cfg.columns)
  } catch (err) {
    results.push({ table, status: 'error', reason: err.message })
    totalIssues += 1
    continue
  }

  const diff = diffRows(section.rows, prodRows, cfg.pk, cfg.columns)
  const issues =
    diff.missing_in_prod.length + diff.extra_in_prod.length + diff.diverged.length
  if (issues > 0) totalIssues += issues

  results.push({
    table,
    seed_rows: section.rows.length,
    prod_rows: prodRows.length,
    missing_in_prod: diff.missing_in_prod.length,
    extra_in_prod: diff.extra_in_prod.length,
    diverged: diff.diverged.length,
    detail: {
      missing_in_prod: diff.missing_in_prod.slice(0, 10),
      extra_in_prod: diff.extra_in_prod.slice(0, 10),
      diverged: diff.diverged.slice(0, 10),
    },
  })
}

if (asJson) {
  console.log(JSON.stringify({ total_issues: totalIssues, results }, null, 2))
} else {
  console.log(`seed-drift: checked ${results.length} table(s).`)
  console.log('')
  for (const r of results) {
    if (r.status === 'skipped') {
      console.log(`  SKIP   ${r.table.padEnd(22)} — ${r.reason}`)
      continue
    }
    if (r.status === 'error') {
      console.log(`  ERROR  ${r.table.padEnd(22)} — ${r.reason}`)
      continue
    }
    const dot =
      r.missing_in_prod + r.extra_in_prod + r.diverged === 0
        ? '✓'
        : '!'
    console.log(
      `  ${dot}  ${r.table.padEnd(22)} ` +
        `seed=${r.seed_rows.toString().padStart(6)} ` +
        `prod=${r.prod_rows.toString().padStart(6)} ` +
        `missing=${r.missing_in_prod} extra=${r.extra_in_prod} diverged=${r.diverged}`,
    )
    if (r.missing_in_prod > 0) {
      console.log(`     missing_in_prod (showing up to 10):`)
      for (const m of r.detail.missing_in_prod) console.log(`       - ${JSON.stringify(m)}`)
    }
    if (r.diverged > 0) {
      console.log(`     diverged (showing up to 10):`)
      for (const d of r.detail.diverged) {
        console.log(`       - pk=${d.pk}`)
        for (const f of d.fields) {
          console.log(`           ${f.column}: seed=${JSON.stringify(f.seed)} prod=${JSON.stringify(f.prod)}`)
        }
      }
    }
  }
  console.log('')
  console.log(`Total issues: ${totalIssues}`)
}

if (totalIssues > 0 && strict) process.exit(1)
if (results.some((r) => r.status === 'error')) process.exit(1)
process.exit(0)
