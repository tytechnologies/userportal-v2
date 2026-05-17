// GET /api/deals/:id/attributions
import { attributionsRepo } from '~~/server/repositories/attributions.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await attributionsRepo.listForDeal({ event, dealId })
  },
})
