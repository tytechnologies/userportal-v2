// List commission ledger entries for a deal + the rollup summary.
//
// GET /api/deals/:id/commission-ledger?include_void=1
// Returns: { entries: CommissionLedgerEntry[], summary: SummaryRow[] }
//
// RLS gates SELECT — the participant themselves, commissions.view.platform,
// or commissions.ledger.read.team holders see entries.

import { z } from 'zod'
import { commissionLedgerRepo } from '~~/server/repositories/commissionLedger.repo'

const querySchema = z.object({
  include_void: z
    .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')])
    .optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    const includeVoid = query.include_void === '1' || query.include_void === 'true'
    return await commissionLedgerRepo.listForDeal({ event, dealId, includeVoid })
  },
})
