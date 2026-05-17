// Read the derived closing-gate state for a deal.
//
// GET /api/deals/:id/closing-status
// Returns: { deal_id, required_total, required_done, required_blocked,
//            total, done, can_close, pct_complete, next_milestone_id }
//
// Advisory only — the deals.stage_key transition is operator-driven
// and the server does not enforce can_close at the deal-update path.

import { milestonesRepo } from '~~/server/repositories/milestones.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await milestonesRepo.closingStatus({ event, dealId })
  },
})
