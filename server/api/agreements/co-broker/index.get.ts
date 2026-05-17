// GET /api/agreements/co-broker?listing_id=123&status=active
import { z } from 'zod'
import { agreementsRepo } from '~~/server/repositories/agreements.repo'

const querySchema = z.object({
  listing_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['proposed', 'active', 'fulfilled', 'cancelled', 'expired']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await agreementsRepo.listCoBroker({
      event,
      listingId: query.listing_id,
      status: query.status,
    })
  },
})
