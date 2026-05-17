// POST /api/agreements/referral
// Body: ReferralAgreementCreateInput
//
// Creates the agreement in status='proposed'. Recipient (or member of
// recipient org) calls /accept to flip it to active.

import { z } from 'zod'
import { agreementsRepo } from '~~/server/repositories/agreements.repo'

const bodySchema = z.object({
  referrer_user_id: z.string().uuid().nullable().optional(),
  referrer_contact_id: z.number().int().positive().nullable().optional(),
  referrer_organization_id: z.string().uuid().nullable().optional(),
  recipient_user_id: z.string().uuid().nullable().optional(),
  recipient_organization_id: z.string().uuid().nullable().optional(),
  scope_type: z.enum(['deal', 'listing', 'organization', 'open']),
  scope_listing_id: z.number().int().positive().nullable().optional(),
  scope_deal_id: z.string().uuid().nullable().optional(),
  scope_organization_id: z.string().uuid().nullable().optional(),
  terms_kind: z.enum(['percent_of_commission', 'percent_of_deal_value', 'fixed']),
  terms_value: z.number().positive(),
  terms_currency: z.string().length(3).optional(),
  terms_notes: z.string().trim().max(5000).nullable().optional(),
  effective_at: z.string().datetime().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  governance_evidence: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await agreementsRepo.createReferral({ event, input: body })
  },
})
