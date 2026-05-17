// Update a milestone — status transitions, due date, notes, evidence.
//
// PATCH /api/deals/:id/milestones/:mid
// Body: MilestonePatchInput
//
// Status transitions auto-stamp started_at / completed_at /
// completed_by — clients pass status only.

import { z } from 'zod'
import { milestonesRepo } from '~~/server/repositories/milestones.repo'

const evidenceSchema = z
  .object({
    kind: z.enum(['document', 'note', 'external', 'commission_ledger']),
    ref: z.union([z.string(), z.number()]).optional(),
    label: z.string().max(200).optional(),
  })
  .partial()

const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    sequence: z.number().int().min(0).max(10_000).optional(),
    required: z.boolean().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped', 'blocked']).optional(),
    due_at: z.string().datetime().nullable().optional(),
    evidence: evidenceSchema.optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    blocked_reason: z.string().trim().max(500).nullable().optional(),
    skipped_reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine(
    (b) => Object.keys(b).length > 0,
    { message: 'At least one updatable field is required' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const dealId = getRouterParam(event, 'id')
    const milestoneId = getRouterParam(event, 'mid')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    if (!milestoneId || !/^[0-9a-f-]{36}$/i.test(milestoneId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid milestone id' })
    }
    return await milestonesRepo.patch({ event, dealId, milestoneId, input: body })
  },
})
