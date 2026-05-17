// POST /api/units/:id/dues-schedules
import { z } from 'zod'
import { duesSchedulesRepo } from '~~/server/repositories/duesSchedules.repo'

const bodySchema = z.object({
  dues_type: z.string().trim().min(1).max(40),
  billing_target: z.enum(['owner', 'tenant']).optional(),
  amount_minor: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  period: z.enum(['monthly', 'quarterly', 'annual']).optional(),
  billing_day: z.number().int().min(1).max(28),
  next_due_at: z.string().date(),
  auto_generate: z.boolean().optional(),
  effective_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await duesSchedulesRepo.create({ event, unitId: id, input: body })
  },
})
