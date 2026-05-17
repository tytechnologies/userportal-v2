// GET /api/deals/:id/attribution-chain?max_depth=10
//
// Walks the recursive referral chain rooted at this deal's
// attributions. Cycle-safe; truncated at max_depth.

import { z } from 'zod'
import { attributionsRepo } from '~~/server/repositories/attributions.repo'

const querySchema = z.object({
  max_depth: z.coerce.number().int().min(1).max(20).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await attributionsRepo.chain({ event, dealId, maxDepth: query.max_depth ?? 10 })
  },
})
