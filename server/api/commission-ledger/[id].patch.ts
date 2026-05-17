// Patch a commission ledger entry — promote draft to posted, void a
// posted entry, or soft-edit notes / external_reference.
//
// PATCH /api/commission-ledger/:id
// Body: LedgerPatchInput
//
// The DB trigger commission_ledger_post_guard enforces append-only
// semantics on posted rows. Attempting to change amount / entry_kind /
// participant on a posted row returns 409 with guidance to insert a
// reversal/adjustment.

import { z } from 'zod'
import { commissionLedgerRepo } from '~~/server/repositories/commissionLedger.repo'

const bodySchema = z
  .object({
    status: z.enum(['posted', 'void']).optional(),
    void_reason: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    external_reference: z.string().trim().max(120).nullable().optional(),
    amount: z.number().finite().optional(),
    participant_role: z.string().trim().min(1).max(40).optional(),
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
    occurred_at: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (b) => Object.keys(b).length > 0,
    { message: 'At least one updatable field is required' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const ledgerId = getRouterParam(event, 'id')
    if (!ledgerId || !/^[0-9a-f-]{36}$/i.test(ledgerId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid ledger id' })
    }
    return await commissionLedgerRepo.patch({ event, ledgerId, input: body })
  },
})
