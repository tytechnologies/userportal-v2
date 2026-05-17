// Operations dashboard — derived alert feed.
//
// GET /api/admin/ops/alerts?severity=critical|warning|info&limit=100
// Auth: admin.
//
// Reads the public.ops_alerts view (migration 20260507000014). The
// view is itself derived from existing tables — no backing storage,
// no drift, always fresh. This endpoint just thins the surface to
// what the UI needs and applies the optional severity filter.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  category: z.enum(['webhook', 'ingest', 'cron', 'rate_limit']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    let sb: any = (supabase as any)
      .from('ops_alerts')
      .select('key, severity, category, title, detail, metadata, started_at')
      .limit(q.limit)

    if (q.severity) sb = sb.eq('severity', q.severity)
    if (q.category) sb = sb.eq('category', q.category)

    const { data, error } = await sb

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    // Group by severity for convenient consumption.
    const rows = (data ?? []) as Array<{
      key: string
      severity: 'critical' | 'warning' | 'info'
      category: string
      title: string
      detail: string | null
      metadata: Record<string, unknown>
      started_at: string
    }>

    return {
      data: rows,
      counts: {
        critical: rows.filter((r) => r.severity === 'critical').length,
        warning: rows.filter((r) => r.severity === 'warning').length,
        info: rows.filter((r) => r.severity === 'info').length,
      },
    }
  },
})
