// GET /api/organizations/:id/billing/summary
// Returns the organization_billing_summary view row.

import { billingRepo } from '~~/server/repositories/billing.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    return await billingRepo.getSummary({ event, organizationId: id })
  },
})
