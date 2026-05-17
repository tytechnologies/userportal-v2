// POST /api/leases/:id/terminate
// Body: { reason, terminated_at?, early_fee_minor? }

import { z } from 'zod'
import { leasesRepo } from '~~/server/repositories/leases.repo'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
  terminated_at: z.string().datetime().optional(),
  early_fee_minor: z.number().int().min(0).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await leasesRepo.terminate({
      event,
      id,
      reason: body.reason,
      terminatedAt: body.terminated_at,
      earlyFeeMinor: body.early_fee_minor,
    })
  },
})
