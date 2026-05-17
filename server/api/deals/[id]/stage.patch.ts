// Transition a deal to a new stage.
//
// PATCH /api/deals/:id/stage
// Body: { stage_key: string, note?: string }
//
// The deal_stage_history trigger records the transition; the
// repository updates closed_at + closed_won when stage_key is one of
// the terminal stages.

import { z } from 'zod'
import { dealsRepo } from '~~/server/repositories/deals.repo'

const bodySchema = z.object({
  stage_key: z.string().trim().min(1).max(64),
  note: z.string().trim().max(2000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await dealsRepo.updateStage({
      event,
      id,
      newStage: body.stage_key,
      note: body.note,
    })
  },
})
