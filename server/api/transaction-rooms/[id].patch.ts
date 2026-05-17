import { z } from 'zod'
import { transactionRoomsRepo } from '~~/server/repositories/transactionRooms.repo'

const bodySchema = z.object({
  name:               z.string().trim().min(1).max(200).optional(),
  status:             z.enum(['open','in_review','closed','archived','cancelled']).optional(),
  listing_id:         z.number().int().positive().nullable().optional(),
  buyer_contact_id:   z.number().int().positive().nullable().optional(),
  seller_contact_id:  z.number().int().positive().nullable().optional(),
  deal_id:            z.string().uuid().nullable().optional(),
  organization_id:    z.string().uuid().nullable().optional(),
  metadata:           z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid room id' })
    }
    return await transactionRoomsRepo.patch({
      event,
      id,
      input: {
        name:              body.name,
        status:            body.status,
        listingId:         body.listing_id,
        buyerContactId:    body.buyer_contact_id,
        sellerContactId:   body.seller_contact_id,
        dealId:            body.deal_id,
        organizationId:    body.organization_id,
        metadata:          body.metadata,
      },
    })
  },
})
