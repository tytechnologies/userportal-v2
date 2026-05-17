// Inquiry funnel splits in a date-bounded window. Drives the
// InquiryFunnel widget when the dashboard date range filter is
// active. Falls back to "all-time" when no from/to is passed —
// matching the existing /api/dashboard/stats funnel branch.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { resolveDashboardScope } from '~~/server/utils/dashboardScope'

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to:   z.string().datetime().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const q = query as z.infer<typeof querySchema>
    const scope = await resolveDashboardScope(event, supabase)

    if (q.from && q.to) {
      // Range RPC scope note: dashboard_inquiry_funnel_range was built
      // platform-wide. For brokers/agents we bypass the RPC and use
      // direct counts with the ownership filter applied — small enough
      // result set that 4 round trips is cheap. Admins keep the RPC
      // path for the platform-wide aggregate.
      if (scope.isAdmin) {
        const fromDate = q.from.slice(0, 10)
        const toDate = q.to.slice(0, 10)
        const { data, error } = await (supabase as any).rpc('dashboard_inquiry_funnel_range', {
          from_date: fromDate,
          to_date: toDate,
        })
        if (error) {
          logger.error({ err: error.message, op: 'dashboard.inquiry_funnel.range' }, 'inquiry_funnel_range_failed')
          return { new: 0, in_progress: 0, replied: 0, closed: 0 }
        }
        const buckets = { new: 0, in_progress: 0, replied: 0, closed: 0 }
        for (const row of ((data ?? []) as Array<{ status: string; count: number }>)) {
          if (row.status in buckets) {
            (buckets as any)[row.status] = Number(row.count) || 0
          }
        }
        return buckets
      }
      // Non-admin range path falls through to count-by-status with
      // bounded date predicates.
    }

    // Count per status with scope + optional date range.
    async function countByStatus(status: string): Promise<number> {
      let qb: any = (supabase as any)
        .from('inquiries')
        .select('id', { count: 'exact', head: true })
        .eq('status', status)
      qb = scope.scopeInquiries(qb)
      if (q.from) qb = qb.gte('created_at', q.from)
      if (q.to)   qb = qb.lte('created_at', q.to)
      const { count, error } = await qb
      if (error) return 0
      return count ?? 0
    }
    const [n, ip, rp, cl] = await Promise.all([
      countByStatus('new'),
      countByStatus('in_progress'),
      countByStatus('replied'),
      countByStatus('closed'),
    ])
    return { new: n, in_progress: ip, replied: rp, closed: cl }
  },
})
