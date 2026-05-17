// Edit your own review (or, with reviews.moderate, hide/unhide).
//
// PATCH /api/reviews/:id
// Auth: required.
//
// Body:
//   rating?, title?, body?, dimensions?, reviewer_display?
//   hidden? (admin only — boolean; sets hidden_at)
//   hidden_reason? (when hidden=true)

import { z } from 'zod'
import { reviewsRepo } from '~~/server/repositories/reviews.repo'

const bodySchema = z.object({
  rating: z.number().min(1).max(5).optional(),
  title: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(5000).optional(),
  dimensions: z.record(z.number()).optional(),
  reviewer_display: z.enum(['full_name', 'initials_only', 'hidden']).optional(),
  hidden: z.boolean().optional(),
  hidden_reason: z.string().trim().max(2000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid review id' })
    }

    // Moderation hide path is exclusive of content edits to keep the
    // audit verbs clean.
    if (body.hidden === true) {
      return await reviewsRepo.hide({
        event,
        id,
        reason: body.hidden_reason || 'Hidden by moderator',
      })
    }

    return await reviewsRepo.update({
      event,
      id,
      rating: body.rating,
      title: body.title ?? undefined,
      body: body.body,
      dimensions: body.dimensions,
      reviewerDisplay: body.reviewer_display,
    })
  },
})
