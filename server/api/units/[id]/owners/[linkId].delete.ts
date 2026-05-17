// DELETE /api/units/:id/owners/:linkId
// Soft-end: stamps ended_at on the unit_owners link.

import { ownersRepo } from '~~/server/repositories/owners.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const unitId = getRouterParam(event, 'id')
    const linkId = getRouterParam(event, 'linkId')
    if (!unitId || !/^[0-9a-f-]{36}$/i.test(unitId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    if (!linkId || !/^[0-9a-f-]{36}$/i.test(linkId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid link id' })
    }
    return await ownersRepo.endOwnership({ event, unitId, linkId })
  },
})
