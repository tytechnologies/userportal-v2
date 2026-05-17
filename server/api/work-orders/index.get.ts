// GET /api/work-orders?unit_id=...&request_id=...&vendor_id=...&status=assigned

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const querySchema = z.object({
  unit_id: z.string().uuid().optional(),
  request_id: z.string().uuid().optional(),
  vendor_id: z.string().uuid().optional(),
  status: z
    .enum(['draft', 'pending_assignment', 'assigned', 'in_progress', 'completed', 'cancelled'])
    .optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await maintenanceRepo.listWorkOrders({
      event,
      unitId: query.unit_id,
      requestId: query.request_id,
      vendorId: query.vendor_id,
      status: query.status,
    })
  },
})
