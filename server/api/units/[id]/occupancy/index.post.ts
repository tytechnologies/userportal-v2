// POST /api/units/:id/occupancy
// Records a new occupancy row. Closes any prior open row at the
// repository level (move_out_at = move_in_at).

import { z } from 'zod'
import { occupancyRepo } from '~~/server/repositories/occupancy.repo'

const bodySchema = z.object({
  occupancy_kind: z.enum([
    'owner_occupied',
    'tenant_lease',
    'vacant',
    'developer_held',
    'undisclosed',
  ]),
  occupant_user_id: z.string().uuid().nullable().optional(),
  occupant_contact_id: z.number().int().positive().nullable().optional(),
  occupant_external_name: z.string().trim().max(200).nullable().optional(),
  occupant_external_email: z.string().email().max(254).nullable().optional(),
  lease_id: z.string().uuid().nullable().optional(),
  move_in_at: z.string().datetime().optional(),
  source: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await occupancyRepo.record({ event, unitId: id, input: body })
  },
})
