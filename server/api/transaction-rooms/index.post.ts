// Create a transaction room. agent+ role gate; RLS additionally
// requires `transactions.write` for non-owners.

import { z } from 'zod'
import { transactionRoomsRepo } from '~~/server/repositories/transactionRooms.repo'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.object({
  name:               z.string().trim().min(1).max(200),
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
    await requireRole(event, 'agent')
    const data = await transactionRoomsRepo.create({
      event,
      input: {
        name:              body.name,
        listingId:         body.listing_id        ?? null,
        buyerContactId:    body.buyer_contact_id  ?? null,
        sellerContactId:   body.seller_contact_id ?? null,
        dealId:            body.deal_id           ?? null,
        organizationId:    body.organization_id   ?? null,
        metadata:          body.metadata          ?? null,
      },
    })
    setResponseStatus(event, 201)
    return data
  },
})
