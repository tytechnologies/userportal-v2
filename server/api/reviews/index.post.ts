// Create / upsert a review.
//
// POST /api/reviews
// Auth: required.
//
// Body:
//   target_type: 'agent' | 'building' | 'developer' | 'listing' | 'owner'
//   target_id:   string (uuid for agent/owner, numeric string otherwise)
//   rating:      number 1.0â€“5.0
//   title?:      string
//   body:        string â‰¤ 5000
//   dimensions?: { responsiveness?, professionalism?, accuracy?,
//                  transparency?, property_condition? }
//   evidence_kind?: 'inquiry' | 'shared_listing' | 'transaction' | 'manual'
//   evidence_ref?:  string
//   reviewer_display?: 'full_name' | 'initials_only' | 'hidden'
//
// Idempotent: re-submitting by same reviewer on same target updates
// the existing row (UNIQUE constraint).
//
// Server-side checks (DB triggers do the heavy lifting):
//   - target_id format matches target_type
//   - reviewer != target (for agent/owner/listing self-reviews)

import { z } from 'zod'
import { reviewsRepo } from '~~/server/repositories/reviews.repo'
import { enforceRateLimit, clientIp } from '~~/server/utils/rate-limit'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  target_type: z.enum(['agent', 'building', 'developer', 'listing', 'owner']),
  target_id: z.string().min(1).max(200),
  rating: z.number().min(1).max(5),
  title: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(5000),
  dimensions: z.record(z.number()).optional(),
  evidence_kind: z.enum(['inquiry', 'shared_listing', 'transaction', 'manual']).optional(),
  evidence_ref: z.string().max(200).optional(),
  reviewer_display: z.enum(['full_name', 'initials_only', 'hidden']).optional(),
}).strict()

// 5 reviews per hour per user â€” generous for normal users, kills
// drive-by review-bombing.
const REVIEW_RATE_LIMIT_MAX = 5
const REVIEW_RATE_LIMIT_WINDOW = 3600

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    try {
      await enforceRateLimit({
        event,
        client,
        key: `reviews:${user.id}`,
        max: REVIEW_RATE_LIMIT_MAX,
        windowSeconds: REVIEW_RATE_LIMIT_WINDOW,
      })
    } catch (err: any) {
      if (err?.statusCode === 429) throw err
      logger.warn(
        { err: err?.message, op: 'reviews.create.rate_limit' },
        'reviews_rate_limit_init_failed',
      )
    }

    const data = await reviewsRepo.create({
      event,
      input: {
        targetType: body.target_type,
        targetId: body.target_id,
        rating: body.rating,
        title: body.title ?? null,
        body: body.body,
        dimensions: body.dimensions,
        evidenceKind: body.evidence_kind,
        evidenceRef: body.evidence_ref,
        reviewerDisplay: body.reviewer_display,
      },
    })

    setResponseStatus(event, 201)
    return data
  },
})
