// Create a commission ledger entry for a deal.
//
// POST /api/deals/:id/commission-ledger
// Body: LedgerCreateInput
//
// Reversal / adjustment entries require parent_entry_id (validated in
// repo + DB CHECK). At least one of participant_user_id /
// participant_contact_id / participant_organization_id must be set.

import { z } from 'zod'
import { commissionLedgerRepo } from '~~/server/repositories/commissionLedger.repo'

const bodySchema = z.object({
  entry_kind: z.enum([
    'projection',
    'earning',
    'invoice',
    'payment',
    'payout',
    'reversal',
    'adjustment',
  ]),
  participant_role: z.string().trim().min(1).max(40),
  amount: z.number().finite(),
  currency: z.string().length(3).optional(),
  participant_user_id: z.string().uuid().nullable().optional(),
  participant_contact_id: z.number().int().positive().nullable().optional(),
  participant_organization_id: z.string().uuid().nullable().optional(),
  deal_commission_id: z.string().uuid().nullable().optional(),
  parent_entry_id: z.string().uuid().nullable().optional(),
  basis_type: z
    .enum([
      'percent_of_deal_value',
      'percent_of_commission',
      'fixed',
      'split_of_parent',
    ])
    .nullable()
    .optional(),
  basis_value: z.number().finite().nullable().optional(),
  external_reference: z.string().trim().max(120).nullable().optional(),
  occurred_at: z.string().datetime().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  status: z.enum(['draft', 'posted']).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await commissionLedgerRepo.create({ event, dealId, input: body })
  },
})
