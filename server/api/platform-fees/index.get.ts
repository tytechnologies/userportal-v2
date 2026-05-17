// GET /api/platform-fees?status=projected
//
// Agent's own platform-fee feed. RLS gates rows to user_id = auth.uid()
// (or admin / platform_fees.manage / brokerage_owner of the org).

import { z } from 'zod'
import { platformFeesRepo } from '~~/server/repositories/platformFees.repo'

const querySchema = z.object({
  status: z.enum(['projected', 'invoiced', 'paid', 'void']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await platformFeesRepo.listCharges({ event, status: query.status })
  },
})
