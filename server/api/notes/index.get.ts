// List CRM notes. RLS scopes to own/team/all per notes.read.*.
//
// Filters:
//   - contact_id / listing_id  → filter the feed for one entity
//   - mine     ?mine=true      → only the caller's notes
//   - pinned   ?pinned=true    → only pinned notes
//
// Order: pinned DESC, then created_at DESC. So pinned float to top.

import { z } from 'zod'
import { notesRepo } from '~~/server/repositories/notes.repo'
import { paginationQueryFields } from '~~/server/utils/pagination'

const querySchema = z.object({
  ...paginationQueryFields,
  contact_id: z.coerce.number().int().positive().optional(),
  listing_id: z.coerce.number().int().positive().optional(),
  mine: z.coerce.boolean().optional(),
  pinned: z.coerce.boolean().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query, user }) => {
    const q = query as z.infer<typeof querySchema>
    return await notesRepo.list({
      event,
      page: q.page,
      pageSize: q.page_size,
      filters: {
        contact_id: q.contact_id,
        listing_id: q.listing_id,
        mine: q.mine,
        pinned: q.pinned,
      },
      userId: user?.id ?? null,
    })
  },
})
