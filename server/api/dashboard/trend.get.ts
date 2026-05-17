// Dashboard trend chart data. Wraps the dashboard_trend_daily RPC and
// shapes the rows into Chart.js-friendly { labels, datasets } so the
// client component is a thin renderer.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { resolveDashboardScope } from '~~/server/utils/dashboardScope'

const querySchema = z.object({
  // Legacy `days` short-form still accepted for callers that haven't
  // migrated to from/to yet (e.g. mobile shortcuts).
  days: z.coerce.number().int().min(1).max(366).default(30),
  /** ISO timestamps. When both are present they take precedence over `days`. */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

type Row = {
  day: string
  inquiries: number
  listings: number
  tasks_done: number
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const q = query as z.infer<typeof querySchema>
    const scope = await resolveDashboardScope(event, supabase)

    // Per-user vs. platform-wide trend. The `_for_user` RPC variants
    // (mig 20260514000006) accept a nullable p_user_id — pass null
    // for admins to get the platform aggregate; pass the caller's id
    // for brokers/agents so their chart reflects only their own
    // inquiries / listings / tasks.
    const userArg = scope.isAdmin ? null : scope.myId

    let data: any
    let error: any
    if (q.from && q.to) {
      const fromDate = q.from.slice(0, 10)
      const toDate = q.to.slice(0, 10)
      ;({ data, error } = await (supabase as any).rpc(
        'dashboard_trend_daily_range_for_user',
        {
          from_date: fromDate,
          to_date: toDate,
          p_user_id: userArg,
        },
      ))
    } else {
      ;({ data, error } = await (supabase as any).rpc(
        'dashboard_trend_daily_for_user',
        {
          days_back: q.days ?? 30,
          p_user_id: userArg,
        },
      ))
    }
    if (error) {
      logger.error({ err: error.message, op: 'dashboard.trend' }, 'dashboard_trend_failed')
      // Return empty so the chart renders an empty state instead of 500ing.
      return { labels: [], datasets: [] }
    }

    const rows = ((data ?? []) as Row[])
    const labels = rows.map((r) => {
      // Short M/D label — the chart legend carries the year if needed.
      const d = new Date(r.day)
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    })

    return {
      labels,
      datasets: [
        {
          label: 'Inquiries',
          data: rows.map((r) => Number(r.inquiries) || 0),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.1)',
          tension: 0.3,
          fill: true,
        },
        {
          label: 'New listings',
          data: rows.map((r) => Number(r.listings) || 0),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.3,
          fill: false,
        },
        {
          label: 'Tasks completed',
          data: rows.map((r) => Number(r.tasks_done) || 0),
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          tension: 0.3,
          fill: false,
        },
      ],
      meta: { total_days_returned: rows.length },
    }
  },
})
