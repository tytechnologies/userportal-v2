// List reviews for a target.
//
// GET /api/reviews?target_type=agent&target_id=<uuid>&page=1&page_size=20
// Auth: optional. Anonymous visitors can read public (non-hidden)
// reviews. The reviews_select_public RLS policy already gates this.

import { z } from 'zod'
import { reviewsRepo } from '~~/server/repositories/reviews.repo'

const querySchema = z.object({
  target_type: z.enum(['agent', 'building', 'developer', 'listing', 'owner']),
  target_id: z.string().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'optional',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    setHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
    return await reviewsRepo.listForTarget({
      event,
      targetType: q.target_type,
      targetId: q.target_id,
      page: q.page,
      pageSize: q.page_size,
    })
  },
})
