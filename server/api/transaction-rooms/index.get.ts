// List transaction rooms. RLS scopes to rooms the caller owns or
// participates in (or all-visible for managers+).

import { z } from 'zod'
import { transactionRoomsRepo } from '~~/server/repositories/transactionRooms.repo'
import { paginationQueryFields } from '~~/server/utils/pagination'

const querySchema = z.object({
  ...paginationQueryFields,
  status:     z.enum(['open','in_review','closed','archived','cancelled']).optional(),
  mine:       z.coerce.boolean().optional(),
  listing_id: z.coerce.number().int().positive().optional(),
  contact_id: z.coerce.number().int().positive().optional(),
  deal_id:    z.string().uuid().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    return await transactionRoomsRepo.list({
      event,
      page: q.page,
      pageSize: q.page_size,
      status: q.status,
      mine: q.mine,
      listingId: q.listing_id,
      contactId: q.contact_id,
      dealId: q.deal_id,
    })
  },
})
