// POST /api/envelopes/:id/void
// Body: { reason: string }
//
// Voids the envelope and consumes any outstanding recipient tokens.

import { z } from 'zod'
import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    return await envelopesRepo.voidEnvelope({ event, id, reason: body.reason })
  },
})
