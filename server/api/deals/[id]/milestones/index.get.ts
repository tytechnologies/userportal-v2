// List closing milestones for a deal.
//
// GET /api/deals/:id/milestones
// Returns: { items: DealMilestone[] } (ordered by sequence asc)

import { milestonesRepo } from '~~/server/repositories/milestones.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await milestonesRepo.list({ event, dealId: id })
  },
})
