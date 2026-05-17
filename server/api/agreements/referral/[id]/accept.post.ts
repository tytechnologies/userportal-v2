// POST /api/agreements/referral/:id/accept
//
// Recipient (or a member of the recipient org) accepts a proposed
// referral agreement. Only callable when status='proposed'.

import { agreementsRepo } from '~~/server/repositories/agreements.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid agreement id' })
    }
    return await agreementsRepo.acceptReferral({ event, id })
  },
})
