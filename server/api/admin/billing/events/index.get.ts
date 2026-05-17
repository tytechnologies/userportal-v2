// GET /api/admin/billing/events?provider=paymongo&status=failed

import { z } from 'zod'
import { paymentEventsRepo } from '~~/server/repositories/paymentEvents.repo'

const querySchema = z.object({
  provider: z.enum(['paymongo', 'maya', 'manual', 'comp']).optional(),
  status: z.enum(['received', 'processed', 'failed', 'ignored']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await paymentEventsRepo.listEvents({
      event,
      provider: query.provider,
      status: query.status,
    })
  },
})
