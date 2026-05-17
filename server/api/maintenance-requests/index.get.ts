// GET /api/maintenance-requests?unit_id=...&lease_id=...&status=submitted

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const querySchema = z.object({
  unit_id: z.string().uuid().optional(),
  lease_id: z.string().uuid().optional(),
  status: z
    .enum(['submitted', 'triaged', 'scheduled', 'in_progress', 'resolved', 'closed', 'cancelled'])
    .optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await maintenanceRepo.listRequests({
      event,
      unitId: query.unit_id,
      leaseId: query.lease_id,
      status: query.status,
    })
  },
})
