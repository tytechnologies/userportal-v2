// PATCH /api/property-owners/:id

import { z } from 'zod'
import { ownersRepo } from '~~/server/repositories/owners.repo'

const bodySchema = z
  .object({
    external_name: z.string().trim().max(200).nullable().optional(),
    external_email: z.string().email().max(254).nullable().optional(),
    tax_id: z.string().trim().max(40).nullable().optional(),
    billing_address: z.record(z.unknown()).optional(),
    bank_account: z.record(z.unknown()).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid owner id' })
    }
    return await ownersRepo.patch({ event, id, input: body })
  },
})
