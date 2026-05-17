// PATCH /api/organizations/:id/billing/account
//
// Upserts the billing account. RLS gates writes to brokerage owners
// of the org or platform billing admins.

import { z } from 'zod'
import { billingRepo } from '~~/server/repositories/billing.repo'

const bodySchema = z
  .object({
    provider: z.enum(['paymongo', 'maya', 'manual', 'comp']).optional(),
    billing_email: z.string().email().max(254).nullable().optional(),
    billing_address: z.record(z.unknown()).optional(),
    tax_id: z.string().trim().max(40).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    return await billingRepo.upsertAccount({ event, organizationId: id, input: body })
  },
})
