// POST /api/leases/:id/rent-schedule
import { z } from 'zod'
import { rentSchedulesRepo } from '~~/server/repositories/rentSchedules.repo'

const bodySchema = z.object({
  tenant_party_id: z.string().uuid().nullable().optional(),
  amount_minor: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  period: z.enum(['monthly', 'quarterly', 'annual']).optional(),
  billing_day: z.number().int().min(1).max(28),
  next_due_at: z.string().date(),
  escalation_kind: z.enum(['none', 'fixed_amount', 'percent', 'cpi_index']).optional(),
  escalation_value: z.number().min(0).optional(),
  escalation_period_months: z.number().int().min(1).max(120).nullable().optional(),
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
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await rentSchedulesRepo.create({ event, leaseId: id, input: body })
  },
})
