// GET /api/leases/:id/maintenance — requests linked to this lease
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await maintenanceRepo.listRequests({ event, leaseId: id })
  },
})
