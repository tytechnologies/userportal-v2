// Update a CRM task. RLS gates this — own/team/all per tasks.write.*.
// completed_at handling and audit emission live in the repo.

import { z } from 'zod'
import { tasksRepo } from '~~/server/repositories/tasks.repo'

// .strict() — see /api/tasks index.post.ts. Surfaces client/server
// field-name skew (`notes` vs `description`, `dueDate` vs `due_at`)
// instead of silently dropping the field.
const bodySchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(10_000).nullable().optional(),
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  due_at: z.string().datetime().nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  listing_id: z.number().int().positive().nullable().optional(),
  assignee_user_id: z.string().uuid().nullable().optional(),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid task id' })
    }
    return await tasksRepo.update({ event, id, input: body })
  },
})
