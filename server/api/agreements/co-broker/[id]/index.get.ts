// GET /api/agreements/co-broker/:id
import { agreementsRepo } from '~~/server/repositories/agreements.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid agreement id' })
    }
    return await agreementsRepo.getCoBroker({ event, id })
  },
})
