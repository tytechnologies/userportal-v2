// PATCH /api/leases/:id/rent-schedule/:scheduleId
import { z } from 'zod'
import { rentSchedulesRepo } from '~~/server/repositories/rentSchedules.repo'

const bodySchema = z
  .object({
    tenant_party_id: z.string().uuid().nullable().optional(),
    amount_minor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    period: z.enum(['monthly', 'quarterly', 'annual']).optional(),
    billing_day: z.number().int().min(1).max(28).optional(),
    next_due_at: z.string().date().optional(),
    escalation_kind: z.enum(['none', 'fixed_amount', 'percent', 'cpi_index']).optional(),
    escalation_value: z.number().min(0).optional(),
    escalation_period_months: z.number().int().min(1).max(120).nullable().optional(),
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
    return await rentSchedulesRepo.patch({ event, scheduleId, input: body })
  },
})
