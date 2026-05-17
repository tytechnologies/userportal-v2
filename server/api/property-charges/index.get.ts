// GET /api/property-charges?unit_id=...&status=open&kind=rent
import { z } from 'zod'
import { propertyChargesRepo } from '~~/server/repositories/propertyCharges.repo'

const querySchema = z.object({
  unit_id: z.string().uuid().optional(),
  lease_id: z.string().uuid().optional(),
  status: z.enum(['draft', 'open', 'paid', 'past_due', 'void', 'forgiven']).optional(),
  kind: z
    .enum([
      'rent', 'dues', 'maintenance_pass_through',
      'damage', 'late_fee', 'security_deposit', 'adjustment',
    ])
    .optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await propertyChargesRepo.list({ event, filter: query })
  },
})
