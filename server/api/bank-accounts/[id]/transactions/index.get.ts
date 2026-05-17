// GET /api/bank-accounts/:id/transactions?status=unmatched
import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const querySchema = z.object({
  status: z.enum(['unmatched', 'matched', 'manual', 'ignored']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid bank account id' })
    }
    return await accountingRepo.listBankTransactions({
      event,
      bankAccountId: id,
      status: query.status,
    })
  },
})
