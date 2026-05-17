// POST /api/leases — create draft lease.

import { z } from 'zod'
import { leasesRepo } from '~~/server/repositories/leases.repo'

const bodySchema = z.object({
  unit_id: z.string().uuid(),
  listing_id: z.number().int().positive().nullable().optional(),
  deal_id: z.string().uuid().nullable().optional(),
  source_document_draft_id: z.string().uuid().nullable().optional(),
  signed_envelope_id: z.string().uuid().nullable().optional(),
  lease_type: z.enum(['residential', 'commercial', 'short_term', 'long_term']).optional(),
  currency: z.string().length(3).optional(),
  rent_minor: z.number().int().min(0),
  rent_period: z.enum(['monthly', 'quarterly', 'annual']).optional(),
  security_deposit_minor: z.number().int().min(0).optional(),
  advance_rent_minor: z.number().int().min(0).optional(),
  effective_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  move_in_date: z.string().date().nullable().optional(),
  move_out_date: z.string().date().nullable().optional(),
  billing_day: z.number().int().min(1).max(28).nullable().optional(),
  escalation_kind: z.enum(['none', 'fixed_amount', 'percent', 'cpi_index']).optional(),
  escalation_value: z.number().min(0).optional(),
  escalation_period_months: z.number().int().min(1).max(120).nullable().optional(),
  utilities_included: z.array(z.string().max(40)).max(20).optional(),
  house_rules: z.string().max(10_000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await leasesRepo.create({ event, input: body })
  },
})
