// POST /api/property-owners
// Body: OwnerInput

import { z } from 'zod'
import { ownersRepo } from '~~/server/repositories/owners.repo'

const bodySchema = z.object({
  user_id: z.string().uuid().nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  external_name: z.string().trim().max(200).nullable().optional(),
  external_email: z.string().email().max(254).nullable().optional(),
  tax_id: z.string().trim().max(40).nullable().optional(),
  billing_address: z.record(z.unknown()).optional(),
  bank_account: z.record(z.unknown()).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await ownersRepo.create({ event, input: body })
  },
})
