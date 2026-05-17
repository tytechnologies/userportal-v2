// POST /api/property-owners/:id/statements
// Body: OwnerStatementInput

import { z } from 'zod'
import { statementsRepo } from '~~/server/repositories/statements.repo'

const bodySchema = z.object({
  period_start: z.string().date(),
  period_end: z.string().date(),
  currency: z.string().length(3).optional(),
  rent_collected_minor: z.number().int().min(0).optional(),
  dues_collected_minor: z.number().int().min(0).optional(),
  expenses_minor: z.number().int().min(0).optional(),
  management_fee_minor: z.number().int().min(0).optional(),
  tax_withheld_minor: z.number().int().min(0).optional(),
  net_disbursement_minor: z.number().int().optional(),
  line_items: z.array(z.record(z.unknown())).max(500).optional(),
  external_reference: z.string().trim().max(120).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid owner id' })
    }
    return await statementsRepo.createOwnerStatement({
      event,
      ownerId: id,
      input: body,
    })
  },
})
