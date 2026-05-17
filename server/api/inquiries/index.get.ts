// List inquiries the caller can see. RLS scopes to assigned/team/all.
//
// Filters:
//   - status        ?status=new|in_progress|replied|closed|spam
//   - listing_id    ?listing_id=42
//   - mine          ?mine=true → only inquiries assigned to caller
//
// Order: created_at DESC (most recent first — matches the agent's
// inbox-style mental model).

import { z } from 'zod'
import { inquiriesRepo } from '~~/server/repositories/inquiries.repo'
import { paginationQueryFields } from '~~/server/utils/pagination'

const querySchema = z.object({
  ...paginationQueryFields,
  status: z.enum(['new', 'in_progress', 'replied', 'closed', 'spam']).optional(),
  listing_id: z.coerce.number().int().positive().optional(),
  mine: z.coerce.boolean().optional(),
  // assigned=unassigned surfaces the admin triage queue (rows with
  // NULL assigned_user_id from bot submissions or the orphan-FK
  // fallback in /api/public/inquiries/index.post.ts).
  assigned: z.enum(['unassigned', 'any']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query, user }) => {
    const q = query as z.infer<typeof querySchema>
    return await inquiriesRepo.list({
      event,
      page: q.page,
      pageSize: q.page_size,
      filters: {
        status: q.status,
        listing_id: q.listing_id,
        mine: q.mine,
        assigned: q.assigned,
      },
      userId: user?.id ?? null,
    })
  },
})
