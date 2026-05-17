// POST /api/journal-entries/:id/reverse
// Body: { reversal_date?: ISO date }

import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z.object({
  reversal_date: z.string().date().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid entry id' })
    }
    return await accountingRepo.reverse({
      event,
      id,
      reversalDate: body.reversal_date,
    })
  },
})
