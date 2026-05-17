// GET /api/units/:id/dues-schedules
import { duesSchedulesRepo } from '~~/server/repositories/duesSchedules.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await duesSchedulesRepo.listForUnit({ event, unitId: id })
  },
})
