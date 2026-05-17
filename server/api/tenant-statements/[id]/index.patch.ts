// PATCH /api/tenant-statements/:id

import { z } from 'zod'
import { statementsRepo } from '~~/server/repositories/statements.repo'

const bodySchema = z
  .object({
    period_start: z.string().date().optional(),
    period_end: z.string().date().optional(),
    currency: z.string().length(3).optional(),
    rent_billed_minor: z.number().int().min(0).optional(),
    other_charges_minor: z.number().int().min(0).optional(),
    payments_received_minor: z.number().int().min(0).optional(),
    balance_due_minor: z.number().int().optional(),
    line_items: z.array(z.record(z.unknown())).max(500).optional(),
    due_at: z.string().datetime().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    status: z.enum(['paid', 'overdue', 'void']).optional(),
    void_reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid statement id' })
    }
    return await statementsRepo.patchTenantStatement({ event, id, input: body })
  },
})
