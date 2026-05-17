// Update a listing share.
//
// PATCH /api/listings/:id/shares/:shareId
// Body (any subset):
//   { status?: 'accepted' | 'revoked',
//     permissions?: object,
//     message?: string | null,
//     expires_at?: ISO8601 | null }
//
// Auth: RLS listing_shares_update gates the actual write — owner can
// flip to revoked OR change permissions; recipient can flip to
// accepted/revoked. Mismatched authority returns 404 (RLS hides the
// row from non-authorized callers, .maybeSingle returns null).
//
// Lifecycle audit verbs:
//   status=accepted → listing.share_accepted
//   status=revoked  → listing.share_revoked
//   permissions/message/expires_at only → listing.share_updated

import { z } from 'zod'
import { sharesRepo } from '~~/server/repositories/shares.repo'

const bodySchema = z.object({
  status: z.enum(['accepted', 'revoked']).optional(),
  permissions: z.record(z.unknown()).optional(),
  message: z.string().trim().max(2000).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const shareId = getRouterParam(event, 'shareId')
    if (!shareId || !/^[0-9a-f-]{36}$/i.test(shareId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid share id' })
    }

    return await sharesRepo.update({
      event,
      id: shareId,
      input: {
        status: body.status,
        permissions: body.permissions,
        message: body.message ?? undefined,
        expiresAt: body.expires_at ?? undefined,
      },
    })
  },
})
