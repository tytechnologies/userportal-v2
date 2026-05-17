// DELETE /api/organizations/:id/billing/payment-methods/:pmId
//
// Soft-detach: marks status='detached'. Real removal at the gateway
// happens when the integration turn lands and we can call the
// gateway's detach endpoint.

import { billingRepo } from '~~/server/repositories/billing.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const orgId = getRouterParam(event, 'id')
    const pmId = getRouterParam(event, 'pmId')
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    if (!pmId || !/^[0-9a-f-]{36}$/i.test(pmId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid payment method id' })
    }
    return await billingRepo.detachMethod({
      event,
      organizationId: orgId,
      paymentMethodId: pmId,
    })
  },
})
