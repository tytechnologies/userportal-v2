// POST /api/deals/:id/workflow/advance
// Body: { stepId, documentId, attestationSignature }
// Returns: { nextStepId: string | null }
//
// :id is the deal id; we validate the step belongs to the deal's workflow
// inside the RPC (cross-deal binding is rejected there too).

import { z } from 'zod'
import { workflowsRepo } from '~~/server/repositories/workflows.repo'

const Body = z.object({
  stepId: z.string().uuid(),
  documentId: z.string().uuid(),
  attestationSignature: z.string().min(1),
})

export default defineApiHandler({
  auth: 'required',
  body: Body,
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    const nextStepId = await workflowsRepo.advance({
      event,
      stepId: body.stepId,
      documentId: body.documentId,
      attestationSignature: body.attestationSignature,
    })
    return { nextStepId }
  },
})
