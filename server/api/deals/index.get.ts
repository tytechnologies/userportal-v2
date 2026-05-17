// List deals.
//
// GET /api/deals?stage_key=&mine=true&page=1&page_size=20
// Auth: required. RLS scopes to deals where caller is participant
// or has deals.read.all.

import { z } from 'zod'
import { dealsRepo } from '~~/server/repositories/deals.repo'
import { paginationQueryFields } from '~~/server/utils/pagination'

const querySchema = z.object({
  ...paginationQueryFields,
  stage_key: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  /** Filter by buyer_contact_id — used by /contacts/[id] to show
   *  every deal that references this client. */
  contact_id: z.coerce.number().int().positive().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    return await dealsRepo.list({
      event,
      page: q.page,
      pageSize: q.page_size,
      stageKey: q.stage_key,
      mine: q.mine,
      contactId: q.contact_id,
    })
  },
})
