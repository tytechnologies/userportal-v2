// PATCH /api/leases/:id — only draft / pending_signature leases editable.

import { z } from 'zod'
import { leasesRepo } from '~~/server/repositories/leases.repo'

const bodySchema = z
  .object({
    listing_id: z.number().int().positive().nullable().optional(),
    deal_id: z.string().uuid().nullable().optional(),
    source_document_draft_id: z.string().uuid().nullable().optional(),
    signed_envelope_id: z.string().uuid().nullable().optional(),
    lease_type: z.enum(['residential', 'commercial', 'short_term', 'long_term']).optional(),
    currency: z.string().length(3).optional(),
    rent_minor: z.number().int().min(0).optional(),
    rent_period: z.enum(['monthly', 'quarterly', 'annual']).optional(),
    security_deposit_minor: z.number().int().min(0).optional(),
    advance_rent_minor: z.number().int().min(0).optional(),
    effective_at: z.string().datetime().optional(),
    expires_at: z.string().datetime().optional(),
    move_in_date: z.string().date().nullable().optional(),
    move_out_date: z.string().date().nullable().optional(),
    billing_day: z.number().int().min(1).max(28).nullable().optional(),
    escalation_kind: z.enum(['none', 'fixed_amount', 'percent', 'cpi_index']).optional(),
    escalation_value: z.number().min(0).optional(),
    escalation_period_months: z.number().int().min(1).max(120).nullable().optional(),
    utilities_included: z.array(z.string().max(40)).max(20).optional(),
    house_rules: z.string().max(10_000).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    status: z.enum(['draft', 'pending_signature', 'cancelled']).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    return await leasesRepo.patch({ event, id, input: body })
  },
})
