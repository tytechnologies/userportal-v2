// POST /api/deals/:id/workflow/abandon
// Body: { workflowId, reason }

import { z } from 'zod'
import { workflowsRepo } from '~~/server/repositories/workflows.repo'

const Body = z.object({
  workflowId: z.string().uuid(),
  reason: z.string().min(1),
})

export default defineApiHandler({
  auth: 'required',
  body: Body,
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    await workflowsRepo.abandon({
      event,
      workflowId: body.workflowId,
      reason: body.reason,
    })
    return { ok: true }
  },
})
