// POST /api/agreements/co-broker
// Body: CoBrokerAgreementCreateInput

import { z } from 'zod'
import { agreementsRepo } from '~~/server/repositories/agreements.repo'

const bodySchema = z.object({
  listing_id: z.number().int().positive(),
  listing_agent_user_id: z.string().uuid().nullable().optional(),
  listing_agent_organization_id: z.string().uuid().nullable().optional(),
  co_broker_user_id: z.string().uuid().nullable().optional(),
  co_broker_organization_id: z.string().uuid().nullable().optional(),
  side: z.enum(['sell_side', 'buy_side', 'both']),
  terms_kind: z.enum(['percent_of_commission', 'percent_of_deal_value', 'fixed']),
  terms_value: z.number().positive(),
  terms_currency: z.string().length(3).optional(),
  terms_notes: z.string().trim().max(5000).nullable().optional(),
  exclusivity: z.enum(['exclusive', 'non_exclusive']).optional(),
  effective_at: z.string().datetime().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  governance_evidence: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await agreementsRepo.createCoBroker({ event, input: body })
  },
})
