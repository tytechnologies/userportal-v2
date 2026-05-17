// Add a participant to a deal.
//
// POST /api/deals/:id/participants
// Auth: required + deal_can_write (RLS).

import { z } from 'zod'
import { dealsRepo } from '~~/server/repositories/deals.repo'

const bodySchema = z.object({
  user_id: z.string().uuid().optional(),
  contact_id: z.number().int().positive().optional(),
  role: z.enum(['buyer_agent', 'seller_agent', 'co_broker', 'referrer', 'buyer', 'seller']),
  split_pct: z.number().int().min(0).max(10000).optional(),
}).refine((p) => p.user_id || p.contact_id, {
  message: 'Either user_id or contact_id is required',
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await dealsRepo.addParticipant({
      event,
      dealId,
      userId: body.user_id,
      contactId: body.contact_id,
      role: body.role,
      splitPct: body.split_pct,
    })
  },
})
