// GET /api/buildings/:id/units?status=active
import { z } from 'zod'
import { unitsRepo } from '~~/server/repositories/units.repo'

const querySchema = z.object({
  status: z.enum(['active', 'inactive', 'demolished']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const idStr = getRouterParam(event, 'id')
    const id = Number(idStr)
    if (!Number.isInteger(id) || id <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid building id' })
    }
    return await unitsRepo.listForBuilding({
      event,
      buildingId: id,
      status: query.status,
    })
  },
})
