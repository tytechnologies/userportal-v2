// Schedule a viewing on a deal.
//
// POST /api/deals/:id/viewings
// Body: { scheduled_at: ISO8601, duration_minutes?, attending_user_id?, notes? }

import { z } from 'zod'
import { dealsRepo } from '~~/server/repositories/deals.repo'

const bodySchema = z.object({
  scheduled_at: z.string().datetime(),
  duration_minutes: z.number().int().min(15).max(480).optional(),
  attending_user_id: z.string().uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    setResponseStatus(event, 201)
    return await dealsRepo.scheduleViewing({
      event,
      dealId,
      scheduledAt: body.scheduled_at,
      durationMinutes: body.duration_minutes,
      attendingUserId: body.attending_user_id,
      notes: body.notes,
    })
  },
})
