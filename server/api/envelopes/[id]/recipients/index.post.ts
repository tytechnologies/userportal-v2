// POST /api/envelopes/:id/recipients
// Body: RecipientInput
//
// RLS enforces that the envelope is still in draft status before the
// INSERT is allowed.

import { z } from 'zod'
import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

const bodySchema = z.object({
  user_id: z.string().uuid().nullable().optional(),
  external_email: z.string().email().max(254).nullable().optional(),
  external_name: z.string().trim().max(120).nullable().optional(),
  role: z.enum(['signer', 'approver', 'viewer', 'cc']).optional(),
  sequence: z.number().int().min(0).max(1000).optional(),
  required: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const envelopeId = getRouterParam(event, 'id')
    if (!envelopeId || !/^[0-9a-f-]{36}$/i.test(envelopeId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    return await envelopesRepo.addRecipient({ event, envelopeId, input: body })
  },
})
