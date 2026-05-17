// POST /api/organizations/:id/api-keys/:keyId/rotate
//
// Generates a new key with the same name+scopes+kind and revokes the
// old one. Returns the new key_value (ONCE).

import { apiKeysRepo } from '~~/server/repositories/apiKeys.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const orgId = getRouterParam(event, 'id')
    const keyId = getRouterParam(event, 'keyId')
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    if (!keyId || !/^[0-9a-f-]{36}$/i.test(keyId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid key id' })
    }
    return await apiKeysRepo.rotate({ event, organizationId: orgId, keyId })
  },
})
