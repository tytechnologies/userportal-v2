// POST /api/work-orders

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const bodySchema = z.object({
  maintenance_request_id: z.string().uuid().nullable().optional(),
  unit_id: z.string().uuid(),
  vendor_id: z.string().uuid().nullable().optional(),
  assigned_user_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).nullable().optional(),
  scope: z.string().trim().max(5000).nullable().optional(),
  cost_estimate_minor: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  billing_target: z.enum(['owner', 'tenant', 'platform']).optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await maintenanceRepo.createWorkOrder({ event, input: body })
  },
})
