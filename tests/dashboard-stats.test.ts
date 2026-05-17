// Smoke test for /api/dashboard/stats.
//
// What this guards against:
//   1. Shape regression — the dashboard reads kpi.* and inquiry_funnel.*;
//      a rename or removal would render blank tiles in production.
//   2. Count-mode regression — if someone reverts the listings count
//      back to `count: 'exact'`, the request will time out under load.
//      We assert here that the source still uses 'estimated'/'planned'
//      so the regression is caught at PR review.
//
// What this does NOT do:
//   * Hit the live Supabase. End-to-end auth + RLS + DB latency would
//     make the test flaky in CI. The endpoint shape is the contract;
//     production smoke tests can verify live behavior.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STATS_PATH = resolve(process.cwd(), 'server/api/dashboard/stats.get.ts')
const ATTENTION_PATH = resolve(process.cwd(), 'server/api/dashboard/attention.get.ts')

describe('dashboard stats endpoint', () => {
  it('uses estimated/planned count on the listings table', () => {
    const src = readFileSync(STATS_PATH, 'utf8')
    // Find every `from('listings')` block and verify it doesn't pair
    // with `count: 'exact'`. We accept either 'estimated' or 'planned'
    // — both avoid the full sequential scan.
    const listingsCountRegex =
      /from\(['"]listings['"]\)[\s\S]*?count:\s*['"](exact|estimated|planned)['"]/g
    const matches = [...src.matchAll(listingsCountRegex)]
    expect(matches.length).toBeGreaterThan(0)
    for (const m of matches) {
      expect(['estimated', 'planned']).toContain(m[1])
    }
  })

  it('attention endpoint avoids count(exact) on listings', () => {
    const src = readFileSync(ATTENTION_PATH, 'utf8')
    // Same rule — every listings count must be planned/estimated.
    const re = /from\(['"]listings['"]\)[\s\S]*?count:\s*['"](exact|estimated|planned)['"]/g
    const matches = [...src.matchAll(re)]
    expect(matches.length).toBeGreaterThan(0)
    for (const m of matches) {
      expect(['estimated', 'planned']).toContain(m[1])
    }
  })

  it('returns the documented shape (key contract)', () => {
    // Pure shape contract — verifies the docstring + return statement
    // promise the dashboard consumes.
    const src = readFileSync(STATS_PATH, 'utf8')
    expect(src).toMatch(/active_listings:/)
    expect(src).toMatch(/new_inquiries_7d:/)
    expect(src).toMatch(/open_tasks_mine:/)
    expect(src).toMatch(/pending_shares_incoming:/)
    expect(src).toMatch(/inquiry_funnel:/)
  })
})
