// POST /api/property-charges/:id/record-payment
// Body: { amount_minor, intent_id? }

import { z } from 'zod'
import { propertyChargesRepo } from '~~/server/repositories/propertyCharges.repo'

const bodySchema = z.object({
  amount_minor: z.number().int().min(0),
  intent_id: z.string().uuid().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid charge id' })
    }
    return await propertyChargesRepo.recordPayment({
      event,
      id,
      amountMinor: body.amount_minor,
      intentId: body.intent_id,
    })
  },
})
