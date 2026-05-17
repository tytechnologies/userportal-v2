// POST /api/bank-accounts/:id/transactions
import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z.object({
  posted_at: z.string().date(),
  description: z.string().trim().max(500).nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  amount_minor: z.number().int(),
  balance_minor: z.number().int().nullable().optional(),
  import_batch_id: z.string().uuid().nullable().optional(),
  source: z.enum(['manual', 'csv_import', 'api_import']).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid bank account id' })
    }
    return await accountingRepo.createBankTransaction({
      event,
      bankAccountId: id,
      input: body,
    })
  },
})
