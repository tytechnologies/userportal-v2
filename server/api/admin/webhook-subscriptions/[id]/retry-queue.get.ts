// Pending retries for one webhook subscription.
//
// GET /api/admin/webhook-subscriptions/:id/retry-queue
// Auth: admin.
//
// Reads the in-flight retry queue (mutable) — what work is scheduled
// to fire on upcoming cron ticks. The audit log of completed attempts
// lives separately in webhook_deliveries; the per-row "View deliveries"
// expander surfaces that. This endpoint surfaces the OTHER side of the
// lifecycle: what's pending.
//
// Returns rows ordered by next_attempt_at ascending — earliest-due
// first matches the order the worker will actually replay them in.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
      .from('webhook_retry_queue')
      .select(
        'id, event_kind, attempt_number, next_attempt_at, ' +
        'last_status, last_error, enqueued_at',
      )
      .eq('subscription_id', id)
      .order('next_attempt_at', { ascending: true })
      .limit(q.limit)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { data: data ?? [] }
  },
})
