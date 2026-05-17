// Resolvers for marketing_ticker_messages.kind values.
//
// Each kind has a small async function that returns a string (the
// substituted {{value}}) or null on failure / empty. The public
// ticker endpoint awaits them in parallel and drops any row whose
// resolver returned null — one broken row doesn't kill the whole
// ticker.
//
// Resolvers MUST be fast (single, indexed count or aggregate) — the
// endpoint serves the public site and gets called on every fresh
// page load. The endpoint adds a 60s cache wrapper on top.

import type { SupabaseClient } from '@supabase/supabase-js'

export type TickerKind =
  | 'static'
  | 'new_listings_recent'
  | 'active_agents'
  | 'total_listings_online'
  | 'city_pulse'

export interface TickerSourceConfig {
  window_days?: number
  city_id?: number
  city_slug?: string
  value?: string
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return n.toLocaleString()
}

function fmtCurrency(n: number, currency = 'PHP'): string {
  // Compact PHP — '₱4.2M', '₱120K'. Keeps the chip width sane.
  const symbol = currency === 'PHP' ? '₱' : ''
  if (n >= 1_000_000_000) return `${symbol}${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${symbol}${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${symbol}${(n / 1_000).toFixed(0)}K`
  return `${symbol}${n.toLocaleString()}`
}

async function resolveNewListingsRecent(
  supabase: SupabaseClient,
  cfg: TickerSourceConfig,
): Promise<string | null> {
  const days = Math.max(1, Math.min(365, Number(cfg.window_days ?? 7)))
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  // count:'planned' to avoid full-scan on listings per
  // feedback_count_exact_on_listings.
  const { count, error } = await (supabase as any)
    .from('listings')
    .select('id', { count: 'planned', head: true })
    .eq('is_online', true)
    .is('deleted_at', null)
    .gte('created_at', cutoff)
  if (error) console.error('[ticker:new_listings_recent]', error)
  if (error || count == null) return null
  return fmtCount(count)
}

async function resolveActiveAgents(
  supabase: SupabaseClient,
  cfg: TickerSourceConfig,
): Promise<string | null> {
  const days = Math.max(1, Math.min(365, Number(cfg.window_days ?? 30)))
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  // Distinct count via a bounded fetch + client-side Set. Avoids a
  // server-side DISTINCT which PostgREST can't easily express.
  const { data, error } = await (supabase as any)
    .from('listings')
    .select('created_by')
    .not('created_by', 'is', null)
    .gte('updated_at', cutoff)
    .limit(50_000)
  if (error) console.error('[ticker:active_agents]', error)
  if (error || !Array.isArray(data)) return null
  const ids = new Set(data.map((r: any) => r.created_by))
  return fmtCount(ids.size)
}

async function resolveTotalListingsOnline(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { count, error } = await (supabase as any)
    .from('listings')
    .select('id', { count: 'planned', head: true })
    .eq('is_online', true)
    .is('deleted_at', null)
  if (error) console.error('[ticker:total_listings_online]', error)
  if (error || count == null) return null
  return fmtCount(count)
}

async function resolveCityPulse(
  supabase: SupabaseClient,
  cfg: TickerSourceConfig,
): Promise<string | null> {
  // Resolve city_id from slug if provided.
  let cityId: number | null = cfg.city_id ?? null
  if (cityId == null && cfg.city_slug) {
    const { data } = await (supabase as any)
      .from('cities')
      .select('id')
      .eq('slug', cfg.city_slug)
      .maybeSingle()
    cityId = data?.id ?? null
  }
  if (cityId == null) return null

  // Median is expensive over a full table — use AVG as a proxy. Two
  // queries: last 30 days, and 31-120 days. Compare.
  const now = Date.now()
  const D30 = new Date(now - 30 * 86400_000).toISOString()
  const D120 = new Date(now - 120 * 86400_000).toISOString()

  const fetchAvg = async (gte: string, lt?: string) => {
    let q: any = (supabase as any)
      .from('public_listing_details')
      .select('sale_price')
      .eq('city_id', cityId)
      .eq('is_online', true)
      .not('sale_price', 'is', null)
      .gte('updated_at', gte)
      .limit(5000)
    if (lt) q = q.lt('updated_at', lt)
    const { data, error } = await q
    if (error || !Array.isArray(data) || data.length === 0) return null
    const sum = data.reduce((acc: number, r: any) => acc + Number(r.sale_price || 0), 0)
    return sum / data.length
  }

  const recentAvg = await fetchAvg(D30)
  const baselineAvg = await fetchAvg(D120, D30)
  if (recentAvg == null || baselineAvg == null || baselineAvg === 0) return null

  const deltaPct = ((recentAvg - baselineAvg) / baselineAvg) * 100
  const arrow = deltaPct > 0.5 ? '▲' : deltaPct < -0.5 ? '▼' : '→'
  return `${fmtCurrency(recentAvg)} ${arrow} ${Math.abs(deltaPct).toFixed(1)}%`
}

export async function resolveTickerValue(
  supabase: SupabaseClient,
  kind: TickerKind,
  config: TickerSourceConfig,
): Promise<string | null> {
  try {
    switch (kind) {
      case 'static':
        return typeof config.value === 'string' ? config.value : ''
      case 'new_listings_recent':
        return await resolveNewListingsRecent(supabase, config)
      case 'active_agents':
        return await resolveActiveAgents(supabase, config)
      case 'total_listings_online':
        return await resolveTotalListingsOnline(supabase)
      case 'city_pulse':
        return await resolveCityPulse(supabase, config)
      default:
        return null
    }
  } catch (err) {
    console.error(`[ticker:resolve:${kind}] threw:`, err)
    return null
  }
}

/**
 * Substitutes {{value}} in the label. Returns the final string the
 * ticker chip displays. When value is null we drop the message
 * entirely (callers should filter on null return from resolve).
 */
export function applyLabelTemplate(label: string, value: string): string {
  return label.replace(/\{\{\s*value\s*\}\}/g, value)
}
