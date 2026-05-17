// POST /api/maintenance-requests/:id/triage
// Body: { status: 'triaged' | 'cancelled', notes? }

import { z } from 'zod'
import { maintenanceRepo } from '~~/server/repositories/maintenance.repo'

const bodySchema = z.object({
  status: z.enum(['triaged', 'cancelled']),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid request id' })
    }
    return await maintenanceRepo.triage({
      event,
      id,
      status: body.status,
      notes: body.notes,
    })
  },
})
