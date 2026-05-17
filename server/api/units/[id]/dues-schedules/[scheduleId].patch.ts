// PATCH /api/units/:id/dues-schedules/:scheduleId
import { z } from 'zod'
import { duesSchedulesRepo } from '~~/server/repositories/duesSchedules.repo'

const bodySchema = z
  .object({
    dues_type: z.string().trim().min(1).max(40).optional(),
    billing_target: z.enum(['owner', 'tenant']).optional(),
    amount_minor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    period: z.enum(['monthly', 'quarterly', 'annual']).optional(),
    billing_day: z.number().int().min(1).max(28).optional(),
    next_due_at: z.string().date().optional(),
    status: z.enum(['active', 'paused', 'ended']).optional(),
    auto_generate: z.boolean().optional(),
    effective_at: z.string().datetime().optional(),
    ended_at: z.string().datetime().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const scheduleId = getRouterParam(event, 'scheduleId')
    if (!scheduleId || !/^[0-9a-f-]{36}$/i.test(scheduleId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid schedule id' })
    }
    return await duesSchedulesRepo.patch({ event, scheduleId, input: body })
  },
})
