// POST /api/deals/:id/attributions
// Body: { agreement_id: uuid, notes?: string }
//
// Attaches a referral_agreement to the deal. RLS requires both
// deal_can_write(deal_id) AND that the caller is a party to the
// agreement (referral_agreement_is_party).

import { z } from 'zod'
import { attributionsRepo } from '~~/server/repositories/attributions.repo'

const bodySchema = z.object({
  agreement_id: z.string().uuid(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await attributionsRepo.attach({
      event,
      dealId,
      agreementId: body.agreement_id,
      notes: body.notes,
    })
  },
})
