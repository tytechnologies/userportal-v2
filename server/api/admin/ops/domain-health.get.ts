// Operations dashboard — per-domain health.
//
// GET /api/admin/ops/domain-health
// Auth: admin.
//
// Single round-trip wrapper around public.ops_domain_health() (mig
// 20260507000044). When the RPC errors (missing on this env, RLS
// rejected, underlying view broken), the endpoint degrades to an
// empty-state payload with `degraded: { reason }` instead of 500.
// The dashboard renders the empty domains rather than the whole
// ops panel crashing.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const EMPTY_SHAPE = {
  captured_at: null as string | null,
  webhooks:      { top_failing: [] as unknown[] },
  ingest:        { top_stale: [] as unknown[] },
  cron:          { top_problems: [] as unknown[] },
  rate_limits:   { top_buckets: [] as unknown[] },
  notifications: { top_kinds: [] as unknown[] },
  search:        { recent_refreshes: [] as unknown[] },
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    let supabase: any
    try {
      supabase = await serverSupabaseClient(event)
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'ops_domain_health.client_init' },
        'ops_domain_health_client_init_failed',
      )
      return { ...EMPTY_SHAPE, degraded: { reason: 'client_init_failed' } }
    }

    try {
      const { data, error } = await (supabase as any).rpc('ops_domain_health')
      if (error) {
        logger.warn(
          {
            err: error.message || '(no message)',
            code: (error as any).code,
            details: (error as any).details,
            hint: (error as any).hint,
            op: 'ops_domain_health.rpc',
          },
          'ops_domain_health_rpc_failed',
        )
        return {
          ...EMPTY_SHAPE,
          degraded: {
            reason: 'rpc_error',
            code: (error as any).code ?? null,
          },
        }
      }
      return data
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'ops_domain_health.rpc' },
        'ops_domain_health_rpc_threw',
      )
      return { ...EMPTY_SHAPE, degraded: { reason: 'rpc_threw' } }
    }
  },
})
