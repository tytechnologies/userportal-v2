// DELETE /api/deals/:id/attributions/:attribId
//
// Detach a referral_agreement from a deal. The agreement itself is
// preserved (only the link is removed).

import { attributionsRepo } from '~~/server/repositories/attributions.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const dealId = getRouterParam(event, 'id')
    const attributionId = getRouterParam(event, 'attribId')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    if (!attributionId || !/^[0-9a-f-]{36}$/i.test(attributionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid attribution id' })
    }
    return await attributionsRepo.detach({ event, dealId, attributionId })
  },
})
