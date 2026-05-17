#!/usr/bin/env node
// scripts/check-reference-drift.mjs
//
// Static drift guard against db-main-reference/.
//
// Companion to check-migrations.mjs (runtime DB check). This one runs
// entirely against the migration FILES — no DB connection — so it
// works on a fresh checkout in CI before any service is up.
//
// What it catches:
//   1. PK-typing rule violation
//        - A reference (initial / old-MySQL) table gains a `uuid
//          PRIMARY KEY` declaration via CREATE TABLE (the reference
//          contract says these tables stay INT-family except for
//          `profiles`, which is UUID 1:1 with auth.users).
//   2. FK-typing drift
//        - A new column is declared `bigint REFERENCES <reference_table>(id)`
//          when the reference declares the PK as INTEGER / SMALLINT.
//          Strictly cosmetic (implicit cast works), but per the user's
//          rule the FK column type should match the referenced PK.
//          Reports as a WARN, not an ERROR — pre-existing migrations
//          have this drift and we're not back-fixing.
//   3. Reference-column rename / drop
//        - ALTER TABLE <reference_table> DROP COLUMN <reference_col>
//        - ALTER TABLE <reference_table> RENAME COLUMN <reference_col>
//          Errors — the user's directive is "reference must stay
//          true / additive only".
//
// What it does NOT do (yet):
//   - Validate that ALTER TABLE ADD COLUMN on reference tables is
//     additive only with sane nullable defaults — that's the spirit
//     of the rule, but ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT X
//     is a legitimate additive operation that just happens to have
//     a default. Catching unsafe variants needs sql-aware parsing.
//   - Validate that new tables NOT in the reference use UUID. The
//     rule allows bigint identity for high-volume queues; we don't
//     want to second-guess legitimate choices.
//
// Usage:
//   pnpm check:reference-drift
//   pnpm check:reference-drift --json
//   pnpm check:reference-drift --since 20260510000000   # only files newer than this prefix
//
// Exit code:
//   0  no drift detected
//   1  drift detected (errors or warnings — depends on --strict)
//   2  internal error (no reference dir, etc.)

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const strict = args.includes('--strict')
const sinceFlag = args.findIndex((a) => a === '--since')
const sinceTs = sinceFlag >= 0 ? args[sinceFlag + 1] : null

// --------------------------------------------------------------------
// The reference set. Hard-coded so this works without parsing the
// reference SQL itself (which uses non-portable DDL).
// --------------------------------------------------------------------
// Tables present in db-main-reference/ — the initial / old-MySQL set.
// Inquiries is EXCLUDED — per user (2026-05-13), inquiries is a NEW
// table even though it appears in db-main-reference/tables.sql, because
// it did not exist in the old MySQL DB. UUID PK + sender_* columns
// are intentional.
const REFERENCE_TABLES = new Set([
  'provinces',
  'cities',
  'barangays',
  'developers',
  'properties',
  'property_types',
  'designations',
  'amenities',
  'property_amenities',
  'contacts',
  'profiles',
  'listings',
  'featured_listings',
  'listing_images',
  'listing_amenities',
  'zonal_values',
  'search_result_pages',
])

// Reference-table PK types (per db-main-reference/*.sql). profiles is
// UUID because it's a 1:1 FK to auth.users; every other reference
// table is INT-family.
const REFERENCE_PK_TYPES = {
  provinces: 'smallint',
  cities: 'smallint',
  barangays: 'integer',
  developers: 'smallint',
  properties: 'integer',
  property_types: 'varchar', // VARCHAR(20)
  designations: 'varchar',
  amenities: 'smallint',
  contacts: 'integer',
  profiles: 'uuid',
  listings: 'integer',
  // featured_listings, listing_images, listing_amenities, property_amenities
  // are composite-keyed or FK-PKs; we check the underlying FK type via
  // the referenced table.
}

const MIG_DIR = path.resolve('supabase/migrations')

// --------------------------------------------------------------------
// File loading
// --------------------------------------------------------------------

function listMigrationFiles() {
  if (!fs.existsSync(MIG_DIR)) {
    console.error(`reference-drift: ${MIG_DIR} not found`)
    process.exit(2)
  }
  const all = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (sinceTs) {
    return all.filter((f) => f >= sinceTs)
  }
  return all
}

// --------------------------------------------------------------------
// Patterns
// --------------------------------------------------------------------

// CREATE TABLE [IF NOT EXISTS] [public.]<name>
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(["']?)(\w+)\1/gi

// Inline column declaration starting at line start (any indent).
// Captures: 1=col_name, 2=type, 3=type_qualifier (e.g. "PRIMARY KEY", "REFERENCES …")
const COL_DECL_RE = /^\s+["']?(\w+)["']?\s+(uuid|bigint|integer|int4|int8|smallint|int2|text|varchar\(?\d*\)?|jsonb|timestamptz?|boolean|numeric\(?\d*,?\d*\)?)\b([^,]*),?\s*$/im

// REFERENCES (public.)?<table>(<col>)
const REFERENCES_RE = /REFERENCES\s+(?:public\.)?(["']?)(\w+)\1\s*\(\s*(["']?)(\w+)\3\s*\)/i

// ALTER TABLE [public.]<name>
const ALTER_TABLE_RE = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(["']?)(\w+)\1/gi

// DROP COLUMN / RENAME COLUMN
const DROP_COLUMN_RE = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(["']?)(\w+)\1/gi
const RENAME_COLUMN_RE = /RENAME\s+COLUMN\s+(["']?)(\w+)\1\s+TO\s+(["']?)(\w+)\3/gi

// Reference columns per table (only the ones declared in reference
// schema; ALTER TABLE ADD COLUMN names that match these and have a
// rename/drop target are violations).
const REFERENCE_COLUMNS = {
  listings: [
    'id', 'property_id', 'contact_id', 'title', 'property_category',
    'property_type', 'status', 'condition', 'description', 'unit_number',
    'is_online', 'for_sale', 'for_rent', 'sale_price', 'rent_price',
    'original_sale_price', 'original_rent_price', 'bedrooms', 'bathrooms',
    'floor_area', 'lot_area', 'parking_spaces', 'lease_term', 'rent_advance',
    'security_deposit', 'association_dues', 'availability_date', 'remarks',
    'created_by', 'updated_by', 'deleted_by', 'created_at', 'updated_at', 'deleted_at',
  ],
  properties: [
    'id', 'city_id', 'barangay_id', 'developer_id', 'name', 'street_address',
    'slug', 'category', 'type', 'year_built', 'coord', 'geom', 'attributes',
    'created_by', 'updated_by', 'deleted_by', 'created_at', 'updated_at', 'deleted_at',
  ],
  contacts: [
    'id', 'owner_user_id', 'full_name', 'designation', 'home_phone',
    'mobile_phone', 'email', 'link', 'notes', 'created_by', 'updated_by',
    'deleted_by', 'created_at', 'updated_at', 'deleted_at',
  ],
  profiles: ['id', 'display_name', 'email', 'contact', 'designation', 'created_at', 'updated_at'],
  cities: ['id', 'province_id', 'slug', 'name', 'description', 'coord', 'geom'],
  barangays: ['id', 'city_id', 'slug', 'name', 'description', 'coord', 'geom'],
  provinces: ['id', 'slug', 'name', 'description', 'coord', 'geom'],
}

// --------------------------------------------------------------------
// Scan
// --------------------------------------------------------------------

const findings = [] // { level: 'error'|'warn', file, line, msg }

function scanFile(file) {
  const fullPath = path.join(MIG_DIR, file)
  const text = fs.readFileSync(fullPath, 'utf8')
  const lines = text.split(/\r?\n/)

  // Pass 1: detect each CREATE TABLE block and check PK rule.
  // Walk lines so we know where the block starts; check columns until ');'.
  for (let i = 0; i < lines.length; i++) {
    const ctMatch = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(["']?)(\w+)\1/i.exec(lines[i])
    if (!ctMatch) continue
    const tableName = ctMatch[2].toLowerCase()

    // Scan forward until the closing ');' of the block.
    let depth = 0
    let scanI = i
    for (; scanI < lines.length; scanI++) {
      const line = lines[scanI]
      for (const ch of line) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
      }
      // CREATE TABLE block ends when the OUTER paren closes (depth=0)
      // AFTER having opened it.
      if (scanI > i && depth === 0) break

      // Within the block, check column declarations.
      const colMatch = COL_DECL_RE.exec(line)
      if (!colMatch) continue
      const colName = colMatch[1].toLowerCase()
      const colType = colMatch[2].toLowerCase()
      const colRest = (colMatch[3] || '').toUpperCase()

      const isPk = colRest.includes('PRIMARY KEY')
      const refMatch = REFERENCES_RE.exec(colRest)

      // (1) PK-typing rule violation: reference table gets a non-conforming PK.
      if (isPk && REFERENCE_TABLES.has(tableName)) {
        const expected = REFERENCE_PK_TYPES[tableName]
        if (expected && !colType.startsWith(expected)) {
          findings.push({
            level: 'error',
            file,
            line: scanI + 1,
            msg:
              `Reference table "${tableName}" declared PK as ${colType}, ` +
              `but db-main-reference says ${expected}. ` +
              `Reference (initial / old-MySQL) tables must keep their original ` +
              `PK type for cross-system JOIN compatibility.`,
          })
        }
      }

      // (2) FK-typing drift: bigint FK to an INT-family reference table.
      if (refMatch) {
        const refTable = refMatch[2].toLowerCase()
        const refCol = refMatch[4].toLowerCase()
        if (refCol === 'id' && REFERENCE_TABLES.has(refTable)) {
          const expectedPk = REFERENCE_PK_TYPES[refTable]
          if (
            expectedPk &&
            expectedPk !== 'uuid' &&
            colType.startsWith('bigint') &&
            !expectedPk.startsWith('bigint')
          ) {
            findings.push({
              level: 'warn',
              file,
              line: scanI + 1,
              msg:
                `FK column "${colName}" declared bigint but references ${refTable}(id) ` +
                `which is ${expectedPk}. Implicit cast works at runtime; per the PK-typing ` +
                `rule the FK column should match the referenced PK type.`,
            })
          }
        }
      }
    }
    i = scanI // skip ahead past this CREATE TABLE block
  }

  // Pass 2: ALTER TABLE ... DROP/RENAME COLUMN against reference tables.
  for (let i = 0; i < lines.length; i++) {
    const atMatch = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(["']?)(\w+)\1/i.exec(lines[i])
    if (!atMatch) continue
    const tableName = atMatch[2].toLowerCase()
    if (!REFERENCE_TABLES.has(tableName)) continue

    // Look on the same line + next 5 (typical alter table block) for DROP/RENAME COLUMN.
    const refCols = new Set((REFERENCE_COLUMNS[tableName] || []).map((c) => c.toLowerCase()))

    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      let m
      const dropRe = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(["']?)(\w+)\1/gi
      while ((m = dropRe.exec(lines[j])) !== null) {
        const colName = m[2].toLowerCase()
        if (refCols.has(colName)) {
          findings.push({
            level: 'error',
            file,
            line: j + 1,
            msg:
              `Migration drops reference column ${tableName}.${colName}. ` +
              `db-main-reference declares this column — reference contract is additive-only.`,
          })
        }
      }
      const renRe = /RENAME\s+COLUMN\s+(["']?)(\w+)\1\s+TO\s+(["']?)(\w+)\3/gi
      while ((m = renRe.exec(lines[j])) !== null) {
        const colName = m[2].toLowerCase()
        if (refCols.has(colName)) {
          findings.push({
            level: 'error',
            file,
            line: j + 1,
            msg:
              `Migration renames reference column ${tableName}.${colName} → ${m[4]}. ` +
              `db-main-reference declares this column — reference contract is additive-only.`,
          })
        }
      }
    }
  }
}

// --------------------------------------------------------------------
// Run
// --------------------------------------------------------------------

const files = listMigrationFiles()
for (const f of files) scanFile(f)

const errors = findings.filter((f) => f.level === 'error')
const warns = findings.filter((f) => f.level === 'warn')

if (asJson) {
  console.log(JSON.stringify({ files_scanned: files.length, errors, warns }, null, 2))
} else {
  console.log(`reference-drift: scanned ${files.length} migration file(s).`)
  if (findings.length === 0) {
    console.log('  no drift detected.')
  } else {
    for (const f of errors) {
      console.log(`  ERROR  ${f.file}:${f.line}  ${f.msg}`)
    }
    for (const f of warns) {
      console.log(`  WARN   ${f.file}:${f.line}  ${f.msg}`)
    }
    console.log('')
    console.log(`Summary: ${errors.length} error(s), ${warns.length} warning(s).`)
  }
}

if (errors.length > 0) process.exit(1)
if (strict && warns.length > 0) process.exit(1)
process.exit(0)
