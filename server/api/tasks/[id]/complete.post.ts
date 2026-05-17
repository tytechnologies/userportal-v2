// Mark a task complete.
//
// POST /api/tasks/:id/complete
// Auth: required. RLS already gates write to assignee + admins.
//
// Stamps completed_at, fires task.completed audit + notification
// to the deal's other participants when applicable.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^([0-9a-f-]{36}|[0-9]+)$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid task id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const { data, error } = await (supabase as any)
      .from('tasks')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', id)
      .is('completed_at', null)  // optimistic concurrency
      .select('id, title, deal_id, listing_id')
      .maybeSingle()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Task not found, already completed, or not yours to close',
      })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'task.completed',
      entity: 'task',
      entityId: data.id,
      metadata: {
        task_id: data.id,
        deal_id: data.deal_id,
        listing_id: data.listing_id,
        completed_by: user?.id ?? null,
      },
    })

    return data
  },
})
