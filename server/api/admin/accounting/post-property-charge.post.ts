// POST /api/admin/accounting/post-property-charge
// Body: { charge_id: uuid }
//
// Operator-driven: creates a draft journal_entry from a paid property
// charge. Operator reviews + posts manually.

import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z.object({
  charge_id: z.string().uuid(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await accountingRepo.autoPostPropertyCharge({ event, chargeId: body.charge_id })
  },
})
