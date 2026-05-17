// Admin — search index queue status.
//
// GET /api/admin/search/index-status
// Returns pending depth, recent throughput, error rate, engine flag.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { isTypesenseEnabled } from '~~/server/utils/typesense'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)

    const [pendingRes, processedRecentRes, recentRes, errorsRes] = await Promise.all([
      (supabase as any)
        .from('search_index_queue')
        .select('id', { count: 'planned' })
        .is('processed_at', null)
        .limit(0),
      (supabase as any)
        .from('search_index_queue')
        .select('id', { count: 'planned' })
        .gte('processed_at', new Date(Date.now() - 3600 * 1000).toISOString())
        .limit(0),
      (supabase as any)
        .from('search_index_queue')
        .select('id, property_id, op, attempts, last_error, enqueued_at, processed_at')
        .order('enqueued_at', { ascending: false })
        .limit(30),
      (supabase as any)
        .from('search_index_queue')
        .select('id', { count: 'planned' })
        .not('last_error', 'is', null)
        .is('processed_at', null)
        .limit(0),
    ])

    return {
      engine_enabled:      isTypesenseEnabled(),
      pending_count:       pendingRes?.count ?? 0,
      processed_last_hour: processedRecentRes?.count ?? 0,
      with_error:          errorsRes?.count ?? 0,
      recent:              recentRes?.data ?? [],
    }
  },
})
