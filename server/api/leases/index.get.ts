// GET /api/leases?unit_id=...&status=active

import { z } from 'zod'
import { leasesRepo } from '~~/server/repositories/leases.repo'

const querySchema = z.object({
  unit_id: z.string().uuid().optional(),
  status: z
    .enum(['draft', 'pending_signature', 'active', 'expired', 'terminated', 'cancelled'])
    .optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await leasesRepo.list({
      event,
      unitId: query.unit_id,
      status: query.status,
    })
  },
})
