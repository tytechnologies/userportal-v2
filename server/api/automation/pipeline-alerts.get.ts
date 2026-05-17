// Pipeline alerts feed — operator-side SLA / stale-state alerts.
//
// GET /api/automation/pipeline-alerts?mine=true&category=&severity=
// Auth: required.
//
// Reads public.pipeline_alerts (SQL view from mig 20260507000024 +
// remediation in mig 20260507000030). `mine=true` scopes to alerts
// where owner_user_id = caller.
//
// Failure model:
//   The dashboard widget that consumes this endpoint is a non-critical
//   surface — if the view query fails (RLS denial, missing column on
//   an underlying table, broken expression on a view rewrite), we
//   degrade to an empty list rather than 5xx the whole dashboard. The
//   error is logged with full PostgREST shape (code/hint/details) so
//   ops can triage. Earlier behavior was to `throw createError(500)`
//   which Cloudflare Tunnel surfaced as a 502 in the browser.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  mine: z.coerce.boolean().optional(),
  category: z.enum(['inquiry', 'deal', 'viewing']).optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

type AlertRow = { severity: string }

function emptyResponse(reason?: string) {
  return {
    data: [] as AlertRow[],
    counts: { critical: 0, warning: 0, info: 0 },
    degraded: reason ? { reason } : undefined,
  }
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    let supabase: any
    let user: any
    try {
      supabase = await serverSupabaseClient(event)
      user = await serverSupabaseUser(event)
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'pipeline_alerts.client_init' },
        'pipeline_alerts_client_init_failed',
      )
      return emptyResponse('client_init_failed')
    }

    // Role-aware default scoping (2026-05-14): if the caller hasn't
    // explicitly asked for platform-wide AND isn't an admin, default
    // to mine=true. Without this, the dashboard widget on a broker's
    // session was leaking org-wide pipeline alerts they have no
    // operational stake in.
    let isAdmin = false
    try {
      const { data, error } = await (supabase as any).rpc('has_permission', {
        permission_to_check: 'admin.access',
      })
      if (!error) isAdmin = data === true
    } catch {
      isAdmin = false
    }
    const effectiveMine =
      q.mine !== undefined ? q.mine : !isAdmin

    let req: any = (supabase as any)
      .from('pipeline_alerts')
      .select('key, severity, category, owner_user_id, title, detail, metadata, started_at')
      .limit(q.limit)

    if (effectiveMine && user?.id) req = req.eq('owner_user_id', user.id)
    if (q.category) req = req.eq('category', q.category)
    if (q.severity) req = req.eq('severity', q.severity)

    let data: AlertRow[] | null = null
    try {
      const result = await req
      if (result.error) {
        logger.warn(
          {
            err: result.error.message || '(no message)',
            code: (result.error as any).code,
            details: (result.error as any).details,
            hint: (result.error as any).hint,
            op: 'pipeline_alerts.query',
            mine: q.mine ?? false,
            user_id: user?.id ?? null,
          },
          'pipeline_alerts_query_failed',
        )
        return emptyResponse('query_error')
      }
      data = (result.data ?? []) as AlertRow[]
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'pipeline_alerts.query' },
        'pipeline_alerts_query_threw',
      )
      return emptyResponse('query_threw')
    }

    return {
      data,
      counts: {
        critical: data.filter((r) => r.severity === 'critical').length,
        warning:  data.filter((r) => r.severity === 'warning').length,
        info:     data.filter((r) => r.severity === 'info').length,
      },
    }
  },
})
