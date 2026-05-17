// GET /api/journal-entries?status=posted&reference_kind=property_charge
import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const querySchema = z.object({
  status: z.enum(['draft', 'posted', 'void']).optional(),
  reference_kind: z.string().trim().max(40).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await accountingRepo.listEntries({
      event,
      status: query.status,
      referenceKind: query.reference_kind,
    })
  },
})
