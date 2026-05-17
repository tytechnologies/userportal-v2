// PATCH /api/admin/units/:id

import { z } from 'zod'
import { unitsRepo } from '~~/server/repositories/units.repo'

const bodySchema = z
  .object({
    floor: z.number().int().min(-10).max(200).nullable().optional(),
    tower: z.string().trim().max(40).nullable().optional(),
    bedrooms: z.number().min(0).max(20).nullable().optional(),
    bathrooms: z.number().min(0).max(20).nullable().optional(),
    floor_area_sqm: z.number().positive().max(10_000).nullable().optional(),
    balcony_area_sqm: z.number().min(0).max(2_000).nullable().optional(),
    parking_slots: z.number().int().min(0).max(20).nullable().optional(),
    storage_units: z.number().int().min(0).max(20).nullable().optional(),
    orientation: z.enum(['N', 'E', 'S', 'W', 'NE', 'NW', 'SE', 'SW']).nullable().optional(),
    facing: z.string().trim().max(40).nullable().optional(),
    unit_type: z
      .enum([
        'studio', '1br', '2br', '3br', '4br_plus',
        'penthouse', 'duplex', 'townhouse', 'commercial',
      ])
      .nullable()
      .optional(),
    status: z.enum(['active', 'inactive', 'demolished']).optional(),
    features: z.record(z.unknown()).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await unitsRepo.patch({ event, id, input: body })
  },
})
