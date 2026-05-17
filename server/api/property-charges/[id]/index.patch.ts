// PATCH /api/property-charges/:id
import { z } from 'zod'
import { propertyChargesRepo } from '~~/server/repositories/propertyCharges.repo'

const bodySchema = z
  .object({
    status: z.enum(['open', 'past_due', 'void', 'forgiven']).optional(),
    void_reason: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    external_reference: z.string().trim().max(120).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid charge id' })
    }
    return await propertyChargesRepo.patch({ event, id, input: body })
  },
})
