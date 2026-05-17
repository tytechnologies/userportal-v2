// POST /api/bank-accounts
import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z.object({
  account_id: z.string().uuid(),
  bank_name: z.string().trim().min(1).max(200),
  account_number: z.string().trim().min(1).max(40),
  account_name: z.string().trim().min(1).max(200),
  branch: z.string().trim().max(200).nullable().optional(),
  swift_code: z.string().trim().max(40).nullable().optional(),
  currency: z.string().length(3).optional(),
  account_type: z.enum(['checking', 'savings', 'time_deposit']).optional(),
  opening_balance_minor: z.number().int().optional(),
  opened_at: z.string().date().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await accountingRepo.createBankAccount({ event, input: body })
  },
})
