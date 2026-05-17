// GET /api/vendors?kind=plumber&status=active

import { z } from 'zod'
import { vendorsRepo } from '~~/server/repositories/vendors.repo'

const querySchema = z.object({
  kind: z.string().trim().max(40).optional(),
  status: z.enum(['active', 'paused', 'suspended', 'archived']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await vendorsRepo.list({
      event,
      kind: query.kind,
      status: query.status,
    })
  },
})
