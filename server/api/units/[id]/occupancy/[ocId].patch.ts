// PATCH /api/units/:id/occupancy/:ocId
// Narrow patch: only move_out_at, lease_id, notes are mutable.

import { z } from 'zod'
import { occupancyRepo } from '~~/server/repositories/occupancy.repo'

const bodySchema = z
  .object({
    move_out_at: z.string().datetime().nullable().optional(),
    lease_id: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const unitId = getRouterParam(event, 'id')
    const ocId = getRouterParam(event, 'ocId')
    if (!unitId || !/^[0-9a-f-]{36}$/i.test(unitId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    if (!ocId || !/^[0-9a-f-]{36}$/i.test(ocId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid occupancy id' })
    }
    return await occupancyRepo.patch({
      event,
      unitId,
      occupancyId: ocId,
      input: body,
    })
  },
})
