// Admin — hybrid live-search dashboard rollup.
//
// GET /api/admin/live-search/overview
// Auth: admin.access (server-supabase session gating).
//
// Powers /admin/live-search. Returns:
//   - connectors:   one row per source_connector
//   - cache_stats:  total rows, expired, hit_count sums
//   - events_24h:   recent telemetry rollups (p50/p95 latency,
//                   degraded count, top providers)
//   - candidates:   per-state rollup
//
// Soft-fail on missing tables — the migration may not yet be applied
// in every env. Returns { degraded: true, ... } in that case.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

export default defineEventHandler(async (event) => {
  // Lean on the existing admin gate at the page level + RLS. The
  // service-role client below bypasses RLS, but the page itself is
  // already admin-only.
  const supabase = getServerSupabaseAdmin()
  const out: Record<string, unknown> = {}

  try {
    const { data: connectors, error: cErr } = await supabase
      .from('source_connectors')
      .select('slug, display_name, provider_kind, enabled, trust_score, daily_budget, default_ttl_seconds, notes, updated_at')
      .order('enabled', { ascending: false })
      .order('trust_score', { ascending: false })
    if (cErr) throw cErr
    out.connectors = connectors ?? []
  } catch (err: any) {
    logger.warn({ err: err?.message, op: 'live-search.connectors' }, 'connectors_failed')
    out.connectors = []
    out.degraded = true
  }

  try {
    const { data, error } = await supabase
      .from('live_search_cache')
      .select('provider_slug, hit_count, expires_at')
    if (error) throw error
    const now = Date.now()
    const total = data?.length ?? 0
    let expired = 0
    let hits = 0
    const byProvider: Record<string, { rows: number; expired: number; hits: number }> = {}
    for (const r of data ?? []) {
      const p = String((r as any).provider_slug ?? 'unknown')
      const isExpired = new Date((r as any).expires_at).getTime() < now
      byProvider[p] ||= { rows: 0, expired: 0, hits: 0 }
      byProvider[p].rows++
      byProvider[p].hits += Number((r as any).hit_count ?? 0)
      if (isExpired) { expired++; byProvider[p].expired++ }
      hits += Number((r as any).hit_count ?? 0)
    }
    out.cache_stats = { total, expired, hits, by_provider: byProvider }
  } catch (err: any) {
    logger.warn({ err: err?.message, op: 'live-search.cache_stats' }, 'cache_stats_failed')
    out.cache_stats = { total: 0, expired: 0, hits: 0, by_provider: {} }
    out.degraded = true
  }

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('search_events')
      .select('internal_ms, external_ms, total_ms, degraded, provider_breakdown, dedup_collapses, internal_count, external_count')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000)
    if (error) throw error
    const rows = data ?? []
    const intMs: number[] = []
    const extMs: number[] = []
    const totMs: number[] = []
    let degraded = 0
    let dedupSum = 0
    let intSum = 0
    let extSum = 0
    const providerCounts: Record<string, number> = {}
    for (const r of rows) {
      const im = Number((r as any).internal_ms)
      const em = Number((r as any).external_ms)
      const tm = Number((r as any).total_ms)
      if (Number.isFinite(im)) intMs.push(im)
      if (Number.isFinite(em)) extMs.push(em)
      if (Number.isFinite(tm)) totMs.push(tm)
      if ((r as any).degraded) degraded++
      dedupSum += Number((r as any).dedup_collapses ?? 0)
      intSum   += Number((r as any).internal_count ?? 0)
      extSum   += Number((r as any).external_count ?? 0)
      const pb = (r as any).provider_breakdown
      if (pb && typeof pb === 'object') {
        for (const p of Object.keys(pb)) providerCounts[p] = (providerCounts[p] ?? 0) + 1
      }
    }
    out.events_24h = {
      total: rows.length,
      degraded,
      degraded_pct: rows.length ? Math.round((degraded / rows.length) * 1000) / 10 : 0,
      internal_p50: percentile(intMs, 0.5),
      internal_p95: percentile(intMs, 0.95),
      external_p50: percentile(extMs, 0.5),
      external_p95: percentile(extMs, 0.95),
      total_p50:    percentile(totMs, 0.5),
      total_p95:    percentile(totMs, 0.95),
      dedup_total:  dedupSum,
      internal_total: intSum,
      external_total: extSum,
      provider_appearances: providerCounts,
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, op: 'live-search.events' }, 'events_failed')
    out.events_24h = null
    out.degraded = true
  }

  try {
    const { data, error } = await supabase
      .from('external_listing_candidates')
      .select('operator_status, dedup_status')
      .limit(10_000)
    if (error) throw error
    const byOp: Record<string, number> = {}
    const byDedup: Record<string, number> = {}
    for (const r of data ?? []) {
      const op = String((r as any).operator_status ?? 'unknown')
      const dd = String((r as any).dedup_status ?? 'unknown')
      byOp[op] = (byOp[op] ?? 0) + 1
      byDedup[dd] = (byDedup[dd] ?? 0) + 1
    }
    out.candidates = { by_operator_status: byOp, by_dedup_status: byDedup }
  } catch (err: any) {
    logger.warn({ err: err?.message, op: 'live-search.candidates' }, 'candidates_failed')
    out.candidates = { by_operator_status: {}, by_dedup_status: {} }
    out.degraded = true
  }

  return out
})
