// GET /api/leases/:id/charges
import { propertyChargesRepo } from '~~/server/repositories/propertyCharges.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await propertyChargesRepo.list({ event, filter: { lease_id: id } })
  },
})
