// Report a review for abuse.
//
// POST /api/reviews/:id/report
// Auth: required. Authenticated users only — anonymous reports would
// be a moderation flood vector.
//
// Body: { reason: string }
//
// One report per (review, reporter); re-submitting updates.

import { z } from 'zod'
import { reviewsRepo } from '~~/server/repositories/reviews.repo'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(2000),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid review id' })
    }
    return await reviewsRepo.report({ event, reviewId: id, reason: body.reason })
  },
})
