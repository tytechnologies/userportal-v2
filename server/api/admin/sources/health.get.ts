// Admin — per-source SLO rollup.
//
// GET /api/admin/sources/health
//
// Surfaces public.source_health joined with public.listing_sources so
// the admin page can show source slug + display name alongside the
// recorded last_success_at / consecutive_failures / rolling_success_pct
// metrics. Populated by record_source_health (mig 513000003), called
// from /api/admin/listings/ingest after each batch.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)

    // Two parallel reads: full source list (so even sources with no
    // health rows yet appear in the table), and the health rollups.
    const [sourcesRes, healthRes] = await Promise.all([
      (supabase as any)
        .from('listing_sources')
        .select('id, slug, display_name, enabled, last_ingested_at, staleness_ttl_hours')
        .order('id', { ascending: true }),
      (supabase as any)
        .from('source_health')
        .select(
          'source_id, last_success_at, last_failure_at, consecutive_failures, ' +
            'rolling_success_pct, avg_duration_ms, alert_state, updated_at',
        ),
    ])

    if (sourcesRes.error) {
      throw createError({ statusCode: 500, statusMessage: sourcesRes.error.message })
    }

    const healthByIdRaw: any[] = healthRes?.data ?? []
    const healthById = new Map<number, any>(
      healthByIdRaw.map((h: any) => [Number(h.source_id), h]),
    )

    const sources = (sourcesRes.data ?? []).map((s: any) => {
      const h = healthById.get(Number(s.id)) ?? null
      return {
        id:                   s.id,
        slug:                 s.slug,
        display_name:         s.display_name,
        enabled:              s.enabled,
        last_ingested_at:     s.last_ingested_at,
        staleness_ttl_hours:  s.staleness_ttl_hours,
        last_success_at:      h?.last_success_at ?? null,
        last_failure_at:      h?.last_failure_at ?? null,
        consecutive_failures: h?.consecutive_failures ?? 0,
        rolling_success_pct:  h?.rolling_success_pct ?? null,
        avg_duration_ms:      h?.avg_duration_ms ?? null,
        alert_state:          h?.alert_state ?? (h ? 'ok' : 'no_data'),
        health_updated_at:    h?.updated_at ?? null,
      }
    })

    // Summary counts for the stat cards.
    const summary = {
      total:    sources.length,
      enabled:  sources.filter((s: any) => s.enabled).length,
      alerting: sources.filter((s: any) => s.alert_state === 'alert').length,
      warning:  sources.filter((s: any) => s.alert_state === 'warning').length,
    }

    return { sources, summary }
  },
})
