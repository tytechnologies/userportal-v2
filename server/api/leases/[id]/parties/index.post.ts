// POST /api/leases/:id/parties

import { z } from 'zod'
import { leasesRepo } from '~~/server/repositories/leases.repo'

const bodySchema = z.object({
  role: z.enum(['landlord', 'tenant', 'guarantor', 'co_signer', 'agent']),
  user_id: z.string().uuid().nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  external_name: z.string().trim().max(200).nullable().optional(),
  external_email: z.string().email().max(254).nullable().optional(),
  share_pct: z.number().min(0).max(100).nullable().optional(),
  is_primary: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const leaseId = getRouterParam(event, 'id')
    if (!leaseId || !/^[0-9a-f-]{36}$/i.test(leaseId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await leasesRepo.addParty({ event, leaseId, input: body })
  },
})
