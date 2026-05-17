// DELETE /api/envelopes/:id/documents/:edid
// Allowed only when envelope is still in draft.

import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const envelopeId = getRouterParam(event, 'id')
    const envelopeDocumentId = getRouterParam(event, 'edid')
    if (!envelopeId || !/^[0-9a-f-]{36}$/i.test(envelopeId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    if (!envelopeDocumentId || !/^[0-9a-f-]{36}$/i.test(envelopeDocumentId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope-document id' })
    }
    return await envelopesRepo.detachDocument({ event, envelopeId, envelopeDocumentId })
  },
})
