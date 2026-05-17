// Run history for a syndication target.
//
// GET /api/admin/listing-syndication/targets/[id]/runs?limit=&run_kind=

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  run_kind: z.enum(['cron', 'manual', 'pull']).optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'manager')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid target id' })
    }

    const admin = getServerSupabaseAdmin()
    let q: any = (admin as any)
      .from('listing_syndication_runs')
      .select(
        'id, run_kind, status, started_at, completed_at, listings_included, listings_excluded, bytes_emitted, errors, push_response_status, pull_origin, metadata',
      )
      .eq('target_id', id)
      .order('started_at', { ascending: false })
      .limit(query.limit)
    if (query.run_kind) q = q.eq('run_kind', query.run_kind)
    if (query.status) q = q.eq('status', query.status)

    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { items: data ?? [] }
  },
})
