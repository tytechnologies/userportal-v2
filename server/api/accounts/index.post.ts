// POST /api/accounts
import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  account_type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  parent_account_id: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
  description: z.string().max(2000).nullable().optional(),
  bir_classification: z
    .enum(['vatable', 'non_vatable', 'exempt', 'zero_rated'])
    .nullable()
    .optional(),
  tax_code: z.string().trim().max(40).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await accountingRepo.createAccount({ event, input: body })
  },
})
