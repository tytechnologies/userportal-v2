// POST /api/envelopes
// Body: EnvelopeCreateInput

import { z } from 'zod'
import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().max(5000).nullable().optional(),
  routing_kind: z.enum(['sequential', 'parallel']).optional(),
  reminder_interval_hours: z.number().int().min(1).max(720).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  deal_id: z.string().uuid().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await envelopesRepo.create({ event, input: body })
  },
})
