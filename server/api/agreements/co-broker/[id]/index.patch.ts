// PATCH /api/agreements/co-broker/:id

import { z } from 'zod'
import { agreementsRepo } from '~~/server/repositories/agreements.repo'

const bodySchema = z
  .object({
    terms_kind: z.enum(['percent_of_commission', 'percent_of_deal_value', 'fixed']).optional(),
    terms_value: z.number().positive().optional(),
    terms_currency: z.string().length(3).optional(),
    terms_notes: z.string().trim().max(5000).nullable().optional(),
    exclusivity: z.enum(['exclusive', 'non_exclusive']).optional(),
    effective_at: z.string().datetime().optional(),
    expires_at: z.string().datetime().nullable().optional(),
    governance_evidence: z.record(z.unknown()).optional(),
    status: z.enum(['cancelled', 'expired', 'fulfilled']).optional(),
    cancel_reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid agreement id' })
    }
    return await agreementsRepo.patchCoBroker({ event, id, input: body })
  },
})
