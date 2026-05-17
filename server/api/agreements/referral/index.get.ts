// GET /api/agreements/referral?status=active
// Returns: { items: ReferralAgreement[] }
//
// RLS gates SELECT to parties of the agreement (or agreements.read.all).

import { z } from 'zod'
import { agreementsRepo } from '~~/server/repositories/agreements.repo'

const querySchema = z.object({
  status: z
    .enum(['proposed', 'active', 'fulfilled', 'cancelled', 'expired'])
    .optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await agreementsRepo.listReferral({ event, status: query.status })
  },
})
