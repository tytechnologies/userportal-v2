// Snooze a task — push due_at out by N days.
//
// POST /api/tasks/:id/snooze
// Body: { days: int 1..30 }
//
// Also resets last_reminder_sent_at so the reminder cron re-fires
// approaching the new due date.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  days: z.number().int().min(1).max(30).default(1),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^([0-9a-f-]{36}|[0-9]+)$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid task id' })
    }

    const supabase = await serverSupabaseClient(event)

    // Read current due_at; compute snooze target.
    const { data: row, error: readErr } = await (supabase as any)
      .from('tasks')
      .select('due_at, completed_at, deal_id')
      .eq('id', id)
      .maybeSingle()
    if (readErr) throw createError({ statusCode: 500, statusMessage: readErr.message })
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Task not found' })
    if (row.completed_at) {
      throw createError({ statusCode: 422, statusMessage: 'Task already completed' })
    }

    const base = row.due_at ? new Date(row.due_at) : new Date()
    const days = body.days ?? 1
    const newDue = new Date(base.getTime() + days * 24 * 60 * 60 * 1000)

    const { data, error } = await (supabase as any)
      .from('tasks')
      .update({
        due_at: newDue.toISOString(),
        last_reminder_sent_at: null,  // re-arm the reminder cron
      })
      .eq('id', id)
      .select('id, title, due_at, deal_id')
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    await logActivity({
      event,
      client: supabase,
      action: 'task.snoozed',
      entity: 'task',
      entityId: id,
      metadata: { days: body.days, new_due_at: newDue.toISOString(), deal_id: row.deal_id },
    })

    return data
  },
})
