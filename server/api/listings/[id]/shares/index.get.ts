// List shares on a listing.
//
// GET /api/listings/:id/shares
// Auth: required. RLS on listing_shares already gates visibility
// (owner / recipient / admin); this endpoint is a thin convenience
// wrapper that joins recipient + sharer profiles in one round trip.

import { sharesRepo } from '~~/server/repositories/shares.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id) || id <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }
    const data = await sharesRepo.listForListing({ event, listingId: id })
    return { data }
  },
})
