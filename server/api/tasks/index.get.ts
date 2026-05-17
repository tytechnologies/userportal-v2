// List CRM tasks. RLS scopes the rows the caller can see (own/team/all
// via tasks.read.* + own-row + assignee fallthrough).
//
// Filters:
//   - status     ?status=open|in_progress|completed|cancelled
//   - assigned   ?assigned=me  → only tasks assigned to caller
//   - mine       ?mine=true    → only tasks the caller owns
//   - contact_id / listing_id  → cross-entity pivots (timeline drawers)
//   - due_before ?due_before=ISO  (overdue panel)
//
// Order: due_at ASC NULLS LAST, then created_at DESC. Tasks with no
// due date sort after dated ones so the urgent stuff floats up.

import { z } from 'zod'
import { tasksRepo } from '~~/server/repositories/tasks.repo'
import { paginationQueryFields } from '~~/server/utils/pagination'

const querySchema = z.object({
  ...paginationQueryFields,
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled']).optional(),
  assigned: z.enum(['me']).optional(),
  mine: z.coerce.boolean().optional(),
  contact_id: z.coerce.number().int().positive().optional(),
  listing_id: z.coerce.number().int().positive().optional(),
  due_before: z.string().datetime().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    return await tasksRepo.list({
      event,
      page: q.page,
      pageSize: q.page_size,
      filters: {
        status: q.status,
        assigned: q.assigned,
        mine: q.mine,
        contact_id: q.contact_id,
        listing_id: q.listing_id,
        due_before: q.due_before,
      },
    })
  },
})
