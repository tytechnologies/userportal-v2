// POST /api/tenant-statements/:id/issue
import { statementsRepo } from '~~/server/repositories/statements.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid statement id' })
    }
    return await statementsRepo.issueTenantStatement({ event, id })
  },
})
