// GET /api/admin/platform-commission-rule
import { platformFeesRepo } from '~~/server/repositories/platformFees.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    return await platformFeesRepo.getRule({ event })
  },
})
