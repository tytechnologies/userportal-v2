// PATCH /api/vendors/:id

import { z } from 'zod'
import { vendorsRepo } from '~~/server/repositories/vendors.repo'

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    kind: z.string().trim().min(1).max(40).optional(),
    contact_id: z.number().int().positive().nullable().optional(),
    email: z.string().email().max(254).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    // tax_id dropped in migration 076; use the dedicated tax-id endpoint.
    service_areas: z.record(z.unknown()).optional(),
    rate_card: z.record(z.unknown()).optional(),
    documents: z.array(z.record(z.unknown())).max(50).optional(),
    status: z.enum(['active', 'paused', 'suspended', 'archived']).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    rating: z.number().min(0).max(5).nullable().optional(),
    withholding_rate_bps: z.number().int().min(0).max(5000).nullable().optional(),
    withholding_atc_code: z.string().trim().max(20).nullable().optional(),
    final_withholding_rate_bps: z.number().int().min(0).max(5000).nullable().optional(),
    final_withholding_atc_code: z.string().trim().max(20).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid vendor id' })
    }
    return await vendorsRepo.patch({ event, id, input: body })
  },
})
