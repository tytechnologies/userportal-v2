// GET /api/units/:id/occupancy
// Returns full history. RLS gates to occupant + listing-owner + admin.

import { occupancyRepo } from '~~/server/repositories/occupancy.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await occupancyRepo.listForUnit({ event, unitId: id })
  },
})
