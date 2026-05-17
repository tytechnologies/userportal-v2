// Create a CRM note. owner_user_id auto-stamps via column DEFAULT
// auth.uid().
//
// Either contact_id or listing_id (or both) typically set; an
// "orphan" note (neither) is allowed for general jot-downs.
//
// Audit + dual notification fanout (contact owner + listing creator,
// deduped) live in the repo.

import { z } from 'zod'
import { notesRepo } from '~~/server/repositories/notes.repo'

const bodySchema = z.object({
  body: z.string().min(1).max(20_000),
  contact_id: z.number().int().positive().nullable().optional(),
  listing_id: z.number().int().positive().nullable().optional(),
  is_pinned: z.boolean().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const data = await notesRepo.create({
      event,
      input: body,
      userId: user?.id ?? null,
    })
    setResponseStatus(event, 201)
    return data
  },
})
