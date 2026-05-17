// Admin activity log query.
//
// The unified `activities` table is already populated by every CRM
// write path (listings, contacts, tasks, notes, inquiries, documents,
// verifications, sources). RLS lets admins read all rows; this endpoint
// surfaces a paginated, filterable view for forensics + support.
//
// Filters:
//   - entity        e.g. 'listing' | 'task' | 'verification' (exact)
//   - action_prefix e.g. 'listing.', 'verification.' (LIKE 'prefix%')
//   - user_id       uuid; activities by this actor
//   - since/until   ISO timestamps; created_at range
//
// Profile join: hydrate actor names client-side via public_profiles
// rather than PostgREST relational select. Avoids the RLS round-trip
// surprises and keeps the activity row shape strictly the table's.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { paginationQueryFields } from '~~/server/utils/pagination'

const querySchema = z.object({
  ...paginationQueryFields,
  entity: z.string().trim().max(40).optional(),
  action_prefix: z.string().trim().max(60).optional(),
  user_id: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
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
      .from('activities')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (q.entity) sb = sb.eq('entity', q.entity)
    if (q.action_prefix) {
      // Sanitize wildcards out — we want a strict prefix match.
      const safe = q.action_prefix.replace(/[%_]/g, '')
      sb = sb.ilike('action', `${safe}%`)
    }
    if (q.user_id) sb = sb.eq('user_id', q.user_id)
    if (q.since) sb = sb.gte('created_at', q.since)
    if (q.until) sb = sb.lte('created_at', q.until)

    const from = (q.page - 1) * q.page_size
    sb = sb.range(from, from + q.page_size - 1)

    const { data, error, count } = await sb
    if (error) {
      logger.error(
        { err: error.message, op: 'admin.activities.list' },
        'admin_activities_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      data: data ?? [],
      total: count ?? 0,
      page: q.page,
      page_size: q.page_size,
      total_pages: count ? Math.ceil(count / q.page_size) : 0,
    }
  },
})
