// PATCH /api/maintenance-requests/:id

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const bodySchema = z
  .object({
    lease_id: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    category: z.string().trim().min(1).max(40).optional(),
    urgency: z.enum(['emergency', 'high', 'normal', 'low']).optional(),
    photos: z.array(z.string().max(500)).max(20).optional(),
    access_window: z.record(z.unknown()).optional(),
    access_granted: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
    status: z
      .enum(['scheduled', 'in_progress', 'resolved', 'closed', 'cancelled'])
      .optional(),
    resolution_summary: z.string().trim().max(5000).nullable().optional(),
    tenant_satisfaction: z.number().int().min(1).max(5).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid request id' })
    }
    return await maintenanceRepo.patchRequest({ event, id, input: body })
  },
})
