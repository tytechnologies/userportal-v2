// Public ticker feed for the marketing banner below the website nav.
//
// GET /api/public/ticker
// Auth: none — public endpoint.
//
// Uses the SERVICE-ROLE client because the resolvers compute
// aggregate counts over `listings` / `cities` / `public_listing_details`,
// all of which have RLS that blocks anon SELECT. The data shipped
// to the caller is just totals/percentages — no row-level leak. The
// anon RLS policy on marketing_ticker_messages is still the
// security boundary for which ROWS get aggregated (enabled = true).
//
// Resolves each enabled row via the matching kind resolver
// (server/utils/tickerResolvers). Rows whose resolver returns null
// are silently dropped (one broken row doesn't kill the ticker).
//
// Response shape:
//   {
//     items: [{ id, kind, label, tone, link_url, priority, value }, ...],
//     refreshed_at: ISO timestamp,
//     degraded?: true   // upstream failure — caller renders empty
//   }
//
// Cached 60s + 5min stale-while-revalidate. A fresh page load
// doesn't hammer the resolvers (each one does at least one count
// or aggregate query).

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import {
  resolveTickerValue,
  applyLabelTemplate,
  type TickerKind,
  type TickerSourceConfig,
} from '~~/server/utils/tickerResolvers'

type Row = {
  id: string
  kind: TickerKind
  label: string
  source_config: TickerSourceConfig
  tone: 'success' | 'warning' | 'destructive' | 'info' | 'primary' | 'neutral'
  link_url: string | null
  priority: number
}

export default defineCachedEventHandler(
  async () => {
    let supabase
    try {
      supabase = getServerSupabaseAdmin()
    } catch (err) {
      // Service-role key not configured — log once per cache window
      // so ops can spot it. Empty banner.
      console.error('[/api/public/ticker] admin client init failed:', err)
      return {
        items: [],
        refreshed_at: new Date().toISOString(),
        degraded: true as const,
      }
    }

    const { data: rows, error } = await (supabase as any)
      .from('marketing_ticker_messages')
      .select('id, kind, label, source_config, tone, link_url, priority')
      .eq('enabled', true)
      .order('priority', { ascending: true })
      .limit(50)

    if (error) {
      console.error('[/api/public/ticker] ticker table read failed:', error)
    }
    if (error || !Array.isArray(rows)) {
      return {
        items: [],
        refreshed_at: new Date().toISOString(),
        degraded: true as const,
      }
    }

    const resolved = await Promise.all(
      (rows as Row[]).map(async (r) => {
        const value = await resolveTickerValue(
          supabase,
          r.kind,
          r.source_config || {},
        )
        if (value == null) return null
        return {
          id: r.id,
          kind: r.kind,
          label: applyLabelTemplate(r.label, value),
          tone: r.tone,
          link_url: r.link_url,
          priority: r.priority,
          value,
        }
      }),
    )

    const items = resolved.filter((x): x is NonNullable<typeof x> => x !== null)

    return {
      items,
      refreshed_at: new Date().toISOString(),
    }
  },
  {
    maxAge: 60,
    staleMaxAge: 300,
    name: 'public-ticker',
    getKey: () => 'all',
  },
)
