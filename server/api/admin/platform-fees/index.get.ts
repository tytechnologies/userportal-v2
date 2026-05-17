// GET /api/admin/platform-fees?status=projected&user_id=...

import { z } from 'zod'
import { platformFeesRepo } from '~~/server/repositories/platformFees.repo'

const querySchema = z.object({
  status: z.enum(['projected', 'invoiced', 'paid', 'void']).optional(),
  user_id: z.string().uuid().optional(),
  organization_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await platformFeesRepo.listCharges({
      event,
      status: query.status,
      userId: query.user_id,
      organizationId: query.organization_id,
      dealId: query.deal_id,
    })
  },
})
