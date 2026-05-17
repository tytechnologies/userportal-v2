// PATCH /api/work-orders/:id

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    scope: z.string().trim().max(5000).nullable().optional(),
    cost_estimate_minor: z.number().int().min(0).nullable().optional(),
    cost_actual_minor: z.number().int().min(0).nullable().optional(),
    currency: z.string().length(3).optional(),
    billing_target: z.enum(['owner', 'tenant', 'platform']).optional(),
    scheduled_at: z.string().datetime().nullable().optional(),
    started_at: z.string().datetime().nullable().optional(),
    completed_at: z.string().datetime().nullable().optional(),
    photos_before: z.array(z.union([z.string(), z.record(z.unknown())])).max(50).optional(),
    photos_after: z.array(z.union([z.string(), z.record(z.unknown())])).max(50).optional(),
    parts_used: z.array(z.record(z.unknown())).max(200).optional(),
    completion_notes: z.string().trim().max(10_000).nullable().optional(),
    approved_by: z.string().uuid().nullable().optional(),
    approved_at: z.string().datetime().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    status: z
      .enum(['pending_assignment', 'in_progress', 'completed', 'cancelled'])
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid work order id' })
    }
    return await maintenanceRepo.patchWorkOrder({ event, id, input: body })
  },
})
