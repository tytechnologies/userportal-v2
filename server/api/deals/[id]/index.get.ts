// Read one deal with participants + viewings + stage history.
//
// GET /api/deals/:id
// Auth: required. RLS via deal_can_read.

import { dealsRepo } from '~~/server/repositories/deals.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await dealsRepo.getById({ event, id })
  },
})
