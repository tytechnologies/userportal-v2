// POST /api/work-orders/:id/assign
// Body: { vendor_id?, assigned_user_id? }

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const bodySchema = z
  .object({
    vendor_id: z.string().uuid().nullable().optional(),
    assigned_user_id: z.string().uuid().nullable().optional(),
  })
  .refine(
    (b) => b.vendor_id || b.assigned_user_id,
    { message: 'At least one of vendor_id or assigned_user_id is required' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid work order id' })
    }
    return await maintenanceRepo.assignWorkOrder({
      event,
      id,
      vendorId: body.vendor_id,
      assignedUserId: body.assigned_user_id,
    })
  },
})
