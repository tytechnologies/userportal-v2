// Create a CRM task. owner_user_id auto-stamps via the column DEFAULT
// auth.uid(); we don't accept it from the client. assignee defaults to
// the owner if omitted. Audit + assignee notification fanout live in
// the repo.

import { z } from 'zod'
import { tasksRepo } from '~~/server/repositories/tasks.repo'

// `.strict()` rejects unknown keys — smoke test 2026-05-14 found
// clients were sending `notes` (DB column is `description`) and
// `dueDate` (DB column is `due_at`) and the server silently dropped
// them while returning 200. Strict mode surfaces every skew.
const bodySchema = z.object({
  title: z.string().min(1).max(300),
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
    const data = await tasksRepo.create({ event, input: body })
    setResponseStatus(event, 201)
    return data
  },
})
