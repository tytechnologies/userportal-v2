// Remove a milestone from a deal.
//
// DELETE /api/deals/:id/milestones/:mid
//
// RLS gates this to deal_can_write holders. Deleting a completed
// milestone is allowed (operator decision); the audit trail in
// activities preserves the history.

import { milestonesRepo } from '~~/server/repositories/milestones.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const dealId = getRouterParam(event, 'id')
    const milestoneId = getRouterParam(event, 'mid')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    if (!milestoneId || !/^[0-9a-f-]{36}$/i.test(milestoneId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid milestone id' })
    }
    return await milestonesRepo.remove({ event, dealId, milestoneId })
  },
})
