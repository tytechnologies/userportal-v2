// GET /api/vendors/:id
import { vendorsRepo } from '~~/server/repositories/vendors.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid vendor id' })
    }
    return await vendorsRepo.get({ event, id })
  },
})
