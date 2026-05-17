// POST /api/admin/accounting/post-platform-fee
// Body: { charge_id: uuid }

import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z.object({
  charge_id: z.string().uuid(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await accountingRepo.autoPostPlatformFee({ event, chargeId: body.charge_id })
  },
})
