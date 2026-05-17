// PATCH /api/envelopes/:id
// Amendments only allowed when status='draft'. RLS enforces this on the
// underlying tables for recipients/documents; the envelope row itself
// can be metadata-edited at any time (operator clarifying title, etc.).

import { z } from 'zod'
import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(5000).nullable().optional(),
    routing_kind: z.enum(['sequential', 'parallel']).optional(),
    reminder_interval_hours: z.number().int().min(1).max(720).nullable().optional(),
    expires_at: z.string().datetime().nullable().optional(),
    deal_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    return await envelopesRepo.patch({ event, id, input: body })
  },
})
