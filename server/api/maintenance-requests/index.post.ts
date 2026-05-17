// POST /api/maintenance-requests

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const bodySchema = z.object({
  unit_id: z.string().uuid(),
  lease_id: z.string().uuid().nullable().optional(),
  reported_by_user_id: z.string().uuid().nullable().optional(),
  reported_by_contact_id: z.number().int().positive().nullable().optional(),
  reporter_external_name: z.string().trim().max(200).nullable().optional(),
  reporter_external_email: z.string().email().max(254).nullable().optional(),
  reporter_role: z.enum(['tenant', 'owner', 'manager', 'visitor', 'staff']).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).nullable().optional(),
  category: z.string().trim().min(1).max(40),
  urgency: z.enum(['emergency', 'high', 'normal', 'low']).optional(),
  photos: z.array(z.string().max(500)).max(20).optional(),
  access_window: z.record(z.unknown()).optional(),
  access_granted: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await maintenanceRepo.createRequest({ event, input: body })
  },
})
