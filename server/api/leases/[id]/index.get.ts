// GET /api/leases/:id — returns { lease, parties }

import { leasesRepo } from '~~/server/repositories/leases.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await leasesRepo.get({ event, id })
  },
})
