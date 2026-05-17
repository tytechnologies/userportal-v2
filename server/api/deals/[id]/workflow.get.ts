// GET /api/deals/:id/workflow
// Returns null when no workflow exists for the deal.
// RLS via deal_can_read drops non-participants to null naturally.

import { workflowsRepo } from '~~/server/repositories/workflows.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await workflowsRepo.getByDealId({ event, dealId: id })
  },
})
