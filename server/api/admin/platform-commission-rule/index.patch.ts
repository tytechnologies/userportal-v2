// PATCH /api/admin/platform-commission-rule
//
// Tunes the platform commission rule. RLS gates writes to
// platform_fees.manage / admin.access.

import { z } from 'zod'
import { platformFeesRepo } from '~~/server/repositories/platformFees.repo'

const bodySchema = z
  .object({
    default_pct: z.number().min(0).max(100).optional(),
    basis_kind: z
      .enum(['percent_of_commission', 'percent_of_deal_value', 'fixed'])
      .optional(),
    applies_to: z.array(z.string().max(40)).max(20).optional(),
    by_stage: z.record(z.number().min(0).max(100)).optional(),
    by_org: z.record(z.number().min(0).max(100)).optional(),
    active: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await platformFeesRepo.patchRule({ event, input: body })
  },
})
