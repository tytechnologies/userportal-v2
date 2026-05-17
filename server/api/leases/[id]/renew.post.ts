// POST /api/leases/:id/renew
// Body: { effective_at, expires_at, rent_minor, security_deposit_minor? }

import { z } from 'zod'
import { leasesRepo } from '~~/server/repositories/leases.repo'

const bodySchema = z.object({
  effective_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  rent_minor: z.number().int().min(0),
  security_deposit_minor: z.number().int().min(0).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await leasesRepo.renew({
      event,
      parentId: id,
      newEffectiveAt: body.effective_at,
      newExpiresAt: body.expires_at,
      newRentMinor: body.rent_minor,
      newSecurityDepositMinor: body.security_deposit_minor,
    })
  },
})
