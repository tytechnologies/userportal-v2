// Recent delivery log for one subscription.
//
// GET /api/admin/webhook-subscriptions/:id/deliveries?limit=20
// Auth: admin.
//
// Powers the "recent deliveries" expander on the subscription row.
// Failure-bias the response: surface the most-recent failures alongside
// recents so a flapping partner is visible at a glance.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('webhook_deliveries')
      .select(
        'id, event_kind, http_status, error_message, response_excerpt, ' +
        'duration_ms, attempted_at, delivery_chain_id',
      )
      .eq('subscription_id', id)
      .order('attempted_at', { ascending: false })
      .limit(q.limit)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { data: data ?? [] }
  },
})
