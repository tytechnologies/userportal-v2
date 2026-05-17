// Create an ad-hoc milestone on a deal.
//
// POST /api/deals/:id/milestones
// Body: MilestoneCreateInput
//
// For applying a template instead of a one-off, see
// /api/deals/:id/milestones/apply-template.

import { z } from 'zod'
import { milestonesRepo } from '~~/server/repositories/milestones.repo'

const evidenceSchema = z
  .object({
    kind: z.enum(['document', 'note', 'external', 'commission_ledger']),
    ref: z.union([z.string(), z.number()]).optional(),
    label: z.string().max(200).optional(),
  })
  .partial()

const bodySchema = z.object({
  milestone_key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_]+$/, 'snake_case lowercase only'),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  sequence: z.number().int().min(0).max(10_000).optional(),
  required: z.boolean().optional(),
  due_at: z.string().datetime().nullable().optional(),
  evidence: evidenceSchema.optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await milestonesRepo.create({ event, dealId: id, input: body })
  },
})
