// GET /api/property-owners/:id
import { ownersRepo } from '~~/server/repositories/owners.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid owner id' })
    }
    return await ownersRepo.get({ event, id })
  },
})
