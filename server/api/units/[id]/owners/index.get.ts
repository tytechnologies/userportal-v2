// GET /api/units/:id/owners
import { ownersRepo } from '~~/server/repositories/owners.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await ownersRepo.listForUnit({ event, unitId: id })
  },
})
