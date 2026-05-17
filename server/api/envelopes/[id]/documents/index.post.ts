// POST /api/envelopes/:id/documents
// Body: { document_draft_id: uuid, display_order?: int }

import { z } from 'zod'
import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

const bodySchema = z.object({
  document_draft_id: z.string().uuid(),
  display_order: z.number().int().min(0).max(10_000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const envelopeId = getRouterParam(event, 'id')
    if (!envelopeId || !/^[0-9a-f-]{36}$/i.test(envelopeId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    return await envelopesRepo.attachDocument({
      event,
      envelopeId,
      documentDraftId: body.document_draft_id,
      displayOrder: body.display_order,
    })
  },
})
