// POST /api/admin/platform-fees/settlement-run
// Body: { period_end?: ISO date }
//
// Sweeps projected charges and creates B6 invoices per agent.
// Default period_end = today.

import { z } from 'zod'
import { platformFeesRepo } from '~~/server/repositories/platformFees.repo'

const bodySchema = z.object({
  period_end: z.string().date().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await platformFeesRepo.settlementRun({
      event,
      periodEnd: body.period_end,
    })
  },
})
