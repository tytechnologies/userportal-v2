// GET /api/maintenance-requests/:id
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid request id' })
    }
    return await maintenanceRepo.getRequest({ event, id })
  },
})
