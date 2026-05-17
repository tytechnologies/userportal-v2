// POST /api/bank-accounts/:id/transactions/:txId/match
// Body: { journal_line_id: uuid }

import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z.object({
  journal_line_id: z.string().uuid(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const bankAccountId = getRouterParam(event, 'id')
    const txId = getRouterParam(event, 'txId')
    if (!bankAccountId || !/^[0-9a-f-]{36}$/i.test(bankAccountId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid bank account id' })
    }
    if (!txId || !/^[0-9a-f-]{36}$/i.test(txId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid transaction id' })
    }
    return await accountingRepo.matchBankTransaction({
      event,
      bankAccountId,
      txId,
      journalLineId: body.journal_line_id,
    })
  },
})
