// Apply a milestone template to a deal — materializes template items
// into deal_milestones rows.
//
// POST /api/deals/:id/milestones/apply-template
// Body: { template_id: uuid, anchor_at?: ISO string }
//
// Idempotent on (deal_id, milestone_key) — re-running adds new
// milestones from the template that aren't already present, but
// does NOT overwrite existing per-deal milestone state.

import { z } from 'zod'
import { milestonesRepo } from '~~/server/repositories/milestones.repo'

const bodySchema = z.object({
  template_id: z.string().uuid(),
  /** Anchor for default_due_offset_hours computation. Defaults to now(). */
  anchor_at: z.string().datetime().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await milestonesRepo.applyTemplate({
      event,
      dealId,
      templateId: body.template_id,
      anchorAt: body.anchor_at,
    })
  },
})
