// GET /api/organizations/:id/api-keys
import { apiKeysRepo } from '~~/server/repositories/apiKeys.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    return await apiKeysRepo.list({ event, organizationId: id })
  },
})
