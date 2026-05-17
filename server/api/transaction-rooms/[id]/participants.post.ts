import { z } from 'zod'
import { transactionRoomsRepo } from '~~/server/repositories/transactionRooms.repo'

const bodySchema = z.object({
  user_id:    z.string().uuid().nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  role:       z.enum([
    'buyer','seller','buyer_agent','seller_agent','co_broker',
    'attorney','witness','notary','manager','observer',
  ]),
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
    return await transactionRoomsRepo.addParticipant({
      event,
      roomId: id,
      input: {
        userId:    body.user_id    ?? null,
        contactId: body.contact_id ?? null,
        role:      body.role,
      },
    })
  },
})
