// POST /api/deals/:id/workflow/start
// Body: { templateKey, titleBranch?, startedVia, envelopeId? }
// Returns: { workflowId }

import { z } from 'zod'
import { workflowsRepo } from '~~/server/repositories/workflows.repo'

const Body = z.object({
  templateKey: z.string().min(1),
  titleBranch: z.enum(['condo', 'land']).nullable().optional(),
  startedVia: z.enum(['envelope_auto', 'manual']),
  envelopeId: z.string().uuid().nullable().optional(),
})

export default defineApiHandler({
  auth: 'required',
  body: Body,
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    const workflowId = await workflowsRepo.start({
      event,
      dealId: id,
      templateKey: body.templateKey,
      titleBranch: body.titleBranch ?? null,
      startedVia: body.startedVia,
      envelopeId: body.envelopeId ?? null,
    })
    return { workflowId }
  },
})
