// Operations dashboard — time-series metrics.
//
// GET /api/admin/ops/metrics?range=24h|7d|30d
// Auth: admin.
//
// Reads system_metric_snapshots, downsampled to a sensible point
// count per range:
//   24h  →  every snapshot (5-min cadence, ~288 points)
//   7d   →  hourly avg (168 points)
//   30d  →  6-hourly avg (120 points)
//
// Downsampling is computed in SQL via date_trunc + AVG so the wire
// payload stays small even for the 30d view.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
})

const RANGE_CONFIG: Record<
  '24h' | '7d' | '30d',
  { since: string; bucket: string }
> = {
  // Postgres interval expressions; embedded into the SELECT below.
  '24h': { since: "now() - interval '24 hours'",  bucket: "5 minutes" },
  '7d':  { since: "now() - interval '7 days'",    bucket: "1 hour" },
  '30d': { since: "now() - interval '30 days'",   bucket: "6 hours" },
}

const NUMERIC_COLUMNS = [
  'listings_online',
  'listings_total_active',
  'listings_soft_deleted',
  'listings_source_imported',
  'listings_orphan_created_by',
  'webhook_subscriptions_enabled',
  'webhook_subscriptions_failing',
  'webhook_retry_queue_depth',
  'webhook_retry_queue_stale',
  'webhook_deliveries_24h',
  'webhook_deliveries_24h_failed',
  'ingest_sources_stale',
  'ingest_runs_24h',
  'ingest_runs_24h_with_errors',
  'inquiries_unassigned_total',
  'inquiries_unassigned_recent_7d',
  'verifications_pending',
  'rate_limit_throttling_now',
] as const

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    const cfg = RANGE_CONFIG[q.range]
    const supabase = await serverSupabaseClient(event)

    // For 24h we don't need to downsample — PostgREST select on the
    // table is enough. For 7d/30d we need a GROUP BY date_trunc which
    // PostgREST can't express; use an inline query via rpc.
    if (q.range === '24h') {
      const { data, error } = await (supabase as any)
        .from('system_metric_snapshots')
        .select(`captured_at, ${NUMERIC_COLUMNS.join(', ')}`)
        .gte('captured_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
        .order('captured_at', { ascending: true })
        .limit(500)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { range: q.range, points: data ?? [] }
    }

    // Downsampled: call the ops_metrics_downsampled RPC, which
    // wraps the date_trunc + avg query so the API doesn't need to
    // build raw SQL at the request layer.
    const { data, error } = await (supabase as any).rpc(
      'ops_metrics_downsampled',
      { p_range: q.range },
    )
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { range: q.range, points: data ?? [] }
  },
})
