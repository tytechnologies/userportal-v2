// POST /api/units/:id/owners
// Body: { owner: OwnerInput, share_pct?, is_primary? }

import { z } from 'zod'
import { ownersRepo } from '~~/server/repositories/owners.repo'

const bodySchema = z.object({
  owner: z.object({
    user_id: z.string().uuid().nullable().optional(),
    contact_id: z.number().int().positive().nullable().optional(),
    external_name: z.string().trim().max(200).nullable().optional(),
    external_email: z.string().email().max(254).nullable().optional(),
    tax_id: z.string().trim().max(40).nullable().optional(),
  }),
  share_pct: z.number().min(0).max(100).nullable().optional(),
  is_primary: z.boolean().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await ownersRepo.registerForUnit({ event, unitId: id, input: body })
  },
})
