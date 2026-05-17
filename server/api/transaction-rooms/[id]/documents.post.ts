// Link an existing document_drafts row to this transaction room.
// Doesn't create the draft — caller should pass an existing draft id
// (the wizard / drafts list provides them).

import { z } from 'zod'
import { transactionRoomsRepo } from '~~/server/repositories/transactionRooms.repo'

const bodySchema = z.object({
  draft_id: z.string().uuid(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid room id' })
    }
    setResponseStatus(event, 201)
    return await transactionRoomsRepo.linkDocument({
      event,
      roomId: id,
      draftId: body.draft_id,
    })
  },
})
