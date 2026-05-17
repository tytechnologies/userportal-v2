// DELETE /api/envelopes/:id/recipients/:rid
// Allowed only when envelope is still in draft.

import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const envelopeId = getRouterParam(event, 'id')
    const recipientId = getRouterParam(event, 'rid')
    if (!envelopeId || !/^[0-9a-f-]{36}$/i.test(envelopeId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    if (!recipientId || !/^[0-9a-f-]{36}$/i.test(recipientId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid recipient id' })
    }
    return await envelopesRepo.removeRecipient({ event, envelopeId, recipientId })
  },
})
