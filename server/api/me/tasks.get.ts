// "My tasks" inbox.
//
// GET /api/me/tasks?filter=overdue|due_today|all&limit=50
// Auth: required. RLS scopes to assigned_to_user_id = caller; the
// filter is applied on top.
//
// Response includes deal + listing context so the dashboard widget
// renders without per-row joins.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'

const querySchema = z.object({
  filter: z.enum(['overdue', 'due_today', 'open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    let req: any = (supabase as any)
      .from('tasks')
      .select(`
        id, title, description, due_at, completed_at, auto_generated,
        deal_id, listing_id, contact_id, metadata, created_at,
        deal:deals!tasks_deal_id_fkey (id, title, stage_key, listing_id),
        listing:listings!tasks_listing_id_fkey (id, title)
      `, { count: 'exact' })
      .eq('assignee_user_id', user.id)
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(q.limit)

    const now = new Date()
    if (q.filter === 'overdue') {
      req = req.lt('due_at', now.toISOString()).is('completed_at', null)
    } else if (q.filter === 'due_today') {
      const startOfDay = new Date(now)
      startOfDay.setHours(0, 0, 0, 0)
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      req = req
        .gte('due_at', startOfDay.toISOString())
        .lte('due_at', endOfDay.toISOString())
        .is('completed_at', null)
    } else if (q.filter === 'open') {
      req = req.is('completed_at', null)
    }
    // 'all' applies no completion filter.

    const { data, error, count } = await req
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return { data: data ?? [], total: count ?? 0 }
  },
})
