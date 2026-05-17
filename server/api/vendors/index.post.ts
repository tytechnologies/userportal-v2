// POST /api/vendors

import { z } from 'zod'
import { vendorsRepo } from '~~/server/repositories/vendors.repo'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(40),
  contact_id: z.number().int().positive().nullable().optional(),
  email: z.string().email().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  // tax_id plaintext dropped in migration 076. Set via the dedicated
  // /api/vendors/:id/tax-id endpoint (calls vendor_set_tax_id RPC).
  service_areas: z.record(z.unknown()).optional(),
  rate_card: z.record(z.unknown()).optional(),
  documents: z.array(z.record(z.unknown())).max(50).optional(),
  status: z.enum(['active', 'paused', 'suspended', 'archived']).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  withholding_rate_bps: z.number().int().min(0).max(5000).nullable().optional(),
  withholding_atc_code: z.string().trim().max(20).nullable().optional(),
  final_withholding_rate_bps: z.number().int().min(0).max(5000).nullable().optional(),
  final_withholding_atc_code: z.string().trim().max(20).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await vendorsRepo.create({ event, input: body })
  },
})
