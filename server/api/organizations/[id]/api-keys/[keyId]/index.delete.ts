// DELETE /api/organizations/:id/api-keys/:keyId
// Body: { reason: string }
//
// Soft-revoke: status='revoked', revoked_at + revoked_by + reason
// stamped. Subsequent verify() returns null.

import { z } from 'zod'
import { apiKeysRepo } from '~~/server/repositories/apiKeys.repo'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const orgId = getRouterParam(event, 'id')
    const keyId = getRouterParam(event, 'keyId')
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    if (!keyId || !/^[0-9a-f-]{36}$/i.test(keyId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid key id' })
    }
    return await apiKeysRepo.revoke({
      event,
      organizationId: orgId,
      keyId,
      reason: body.reason,
    })
  },
})
