// POST /api/admin/billing/events/:id/replay
// Re-dispatch a previously-recorded webhook event.

import { paymentEventsRepo } from '~~/server/repositories/paymentEvents.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid event id' })
    }
    return await paymentEventsRepo.replay({ event, eventRowId: id })
  },
})
