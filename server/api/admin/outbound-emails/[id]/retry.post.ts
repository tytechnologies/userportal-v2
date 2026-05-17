// POST /api/admin/outbound-emails/:id/retry
//
// Forces a failed row back to 'pending' with attempts reset by 1
// (so it doesn't immediately re-fail on the same retry quota).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }

    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('outbound_emails')
      .update({
        status: 'pending',
        scheduled_at: new Date().toISOString(),
        attempts: 0,
        failure_reason: null,
        failed_at: null,
      })
      .eq('id', id)
      .in('status', ['failed', 'cancelled', 'skipped'])
      .select('id, status, scheduled_at')
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Row not found or not in a retryable state',
      })
    }
    return data
  },
})
