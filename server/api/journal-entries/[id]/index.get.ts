// GET /api/journal-entries/:id
import { accountingRepo } from '~~/server/repositories/accounting.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid entry id' })
    }
    return await accountingRepo.getEntry({ event, id })
  },
})
