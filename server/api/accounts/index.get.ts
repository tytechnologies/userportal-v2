// GET /api/accounts?account_type=asset&active=1
import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const querySchema = z.object({
  account_type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']).optional(),
  active: z.union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')]).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await accountingRepo.listAccounts({
      event,
      accountType: query.account_type,
      activeOnly: query.active === '1' || query.active === 'true',
    })
  },
})
