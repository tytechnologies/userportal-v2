// Update an inquiry — primarily for status flips (mark as replied,
// close, mark as spam). RLS limits write to assigned/team/all per
// inquiries.write.* permissions; spam moderation is gated on the
// admin-only listings.write.all permission since marking real
// inquiries as spam is destructive.
//
// replied_at derivation + audit emission live in the repo.

import { z } from 'zod'
import { inquiriesRepo } from '~~/server/repositories/inquiries.repo'

const bodySchema = z.object({
  status: z.enum(['new', 'in_progress', 'replied', 'closed', 'spam']).optional(),
  /** Optional handover — admin can reassign to another agent. */
  assigned_user_id: z.string().uuid().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    // Accept either uuid (newer schema) or numeric (legacy integer
    // primary key). Some databases never had the uuid migration
    // applied; allowing both keeps the same endpoint working
    // regardless. PostgREST coerces the string to the underlying
    // column type at the DB boundary.
    if (!id || !/^([0-9a-f-]{36}|[0-9]+)$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid inquiry id' })
    }
    return await inquiriesRepo.update({ event, id, input: body })
  },
})
