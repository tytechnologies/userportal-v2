// GET /api/admin/accounting/trial-balance
import { accountingRepo } from '~~/server/repositories/accounting.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    return await accountingRepo.trialBalance({ event })
  },
})
