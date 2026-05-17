// GET /api/organizations/:id/billing/invoices?status=open

import { z } from 'zod'
import { billingRepo } from '~~/server/repositories/billing.repo'

const querySchema = z.object({
  status: z
    .enum(['draft', 'open', 'paid', 'past_due', 'void', 'uncollectible'])
    .optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    return await billingRepo.listInvoices({
      event,
      organizationId: id,
      status: query.status,
    })
  },
})
