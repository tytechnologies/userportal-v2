// Inquiry source attribution. Groups inquiries by `source` field over
// the active dashboard date range:
//   - website            — public site submissions (default for the
//                          /api/public/inquiries endpoint)
//   - phone / whatsapp / walk_in / referral / manual — channels
//                          captured by the LogInquiryModal flow
//   - any future channel — surfaces with the same count + %, no
//                          schema change needed (source is free-text)
//
// GET /api/dashboard/inquiry-sources?from=…&to=…
//
// Returns rows sorted DESC by count. RLS already gates which inquiries
// the caller can see; this endpoint just aggregates the visible set.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { resolveDashboardScope } from '~~/server/utils/dashboardScope'

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to:   z.string().datetime({ offset: true }).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    const scope = await resolveDashboardScope(event, supabase)
    const now = Date.now()
    const fromIso = q.from ?? new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const toIso   = q.to   ?? new Date(now).toISOString()

    let qb: any = (supabase as any)
      .from('inquiries')
      .select('source')
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
    qb = scope.scopeInquiries(qb)
    const { data, error } = await qb

    if (error) {
      logger.warn({ err: error.message, op: 'dashboard.inquiry_sources' }, 'inquiry_sources_failed')
      return { items: [], total: 0, period_from: fromIso, period_to: toIso }
    }

    const counts = new Map<string, number>()
    for (const r of (data ?? []) as Array<{ source: string | null }>) {
      const key = (r.source ?? 'unknown').trim() || 'unknown'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const total = (data ?? []).length
    const items = Array.from(counts.entries())
      .map(([source, count]) => ({
        source,
        count,
        pct: total > 0 ? count / total : 0,
      }))
      .sort((a, b) => b.count - a.count)

    return {
      items,
      total,
      period_from: fromIso,
      period_to: toIso,
    }
  },
})
