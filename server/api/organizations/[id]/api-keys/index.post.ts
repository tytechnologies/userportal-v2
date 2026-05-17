// POST /api/organizations/:id/api-keys
// Body: { name, scopes[], kind?, expires_at?, rate_limit_per_minute? }
//
// Returns: { id, key_value, prefix, last4, kind }
//
// IMPORTANT: key_value is returned ONCE. The caller (UI) must surface
// it to the user immediately. After this response, only prefix +
// last4 are readable from the API.

import { z } from 'zod'
import { apiKeysRepo } from '~~/server/repositories/apiKeys.repo'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().regex(/^[a-z][a-z0-9_]*(:[a-z0-9_]+)+$/)).min(1).max(50),
  kind: z.enum(['live', 'test', 'restricted']).optional(),
  expires_at: z.string().datetime().nullable().optional(),
  rate_limit_per_minute: z.number().int().min(1).max(60_000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    return await apiKeysRepo.create({ event, organizationId: id, input: body })
  },
})
