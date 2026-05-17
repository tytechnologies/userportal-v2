// GET /api/deals/:id/commission-preview
//
// Returns commission split candidates for the deal — sourced from
// deal_participants, attributed referral agreements, and active
// co-broker agreements on the deal's listing.
//
// Read-only. Suggested entries; the operator decides which to insert
// into commission_ledger via the existing B1 endpoints.

import { attributionsRepo } from '~~/server/repositories/attributions.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await attributionsRepo.previewSplit({ event, dealId })
  },
})
