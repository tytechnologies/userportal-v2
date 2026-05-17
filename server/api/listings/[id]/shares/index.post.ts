// Create (or re-share) a listing share.
//
// POST /api/listings/:id/shares
// Body:
//   {
//     shared_with_user_id: uuid,
//     share_role?: 'co_broker' | 'viewer',
//     permissions?: { view_listing?, view_inquiries?, ... } (preferred),
//     message?: string,
//     expires_at?: ISO8601
//   }
//
// Auth: required + listings.share permission (the underlying RLS
// listing_shares_insert policy gates on listing ownership OR
// listings.write.all; the repository goes through that policy).
//
// Idempotency: UNIQUE (listing_id, shared_with_user_id) — re-sharing
// updates the existing row (upsert via onConflict in the repo). This
// is the documented re-share-rehydrates-revoked behavior.

import { z } from 'zod'
import { sharesRepo } from '~~/server/repositories/shares.repo'

const bodySchema = z.object({
  shared_with_user_id: z.string().uuid(),
  share_role: z.enum(['co_broker', 'viewer']).optional(),
  permissions: z.record(z.unknown()).optional(),
  message: z.string().trim().max(2000).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id) || id <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const data = await sharesRepo.create({
      event,
      input: {
        listingId: id,
        sharedWithUserId: body.shared_with_user_id,
        shareRole: body.share_role,
        permissions: body.permissions,
        message: body.message ?? null,
        expiresAt: body.expires_at ?? null,
      },
    })

    setResponseStatus(event, 201)
    return data
  },
})
