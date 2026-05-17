// GET /api/bank-accounts
import { accountingRepo } from '~~/server/repositories/accounting.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    return await accountingRepo.listBankAccounts({ event })
  },
})
