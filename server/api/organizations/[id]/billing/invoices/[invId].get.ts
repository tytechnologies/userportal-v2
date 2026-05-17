// GET /api/organizations/:id/billing/invoices/:invId
// Returns: { invoice, intents }

import { billingRepo } from '~~/server/repositories/billing.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const orgId = getRouterParam(event, 'id')
    const invoiceId = getRouterParam(event, 'invId')
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    if (!invoiceId || !/^[0-9a-f-]{36}$/i.test(invoiceId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid invoice id' })
    }
    return await billingRepo.getInvoice({
      event,
      organizationId: orgId,
      invoiceId,
    })
  },
})
