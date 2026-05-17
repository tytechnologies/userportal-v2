// Update a CRM note. RLS gates own/team/all per notes.write.*.

import { z } from 'zod'
import { notesRepo } from '~~/server/repositories/notes.repo'

const bodySchema = z.object({
  body: z.string().min(1).max(20_000).optional(),
  is_pinned: z.boolean().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  listing_id: z.number().int().positive().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid note id' })
    }
    return await notesRepo.update({ event, id, input: body })
  },
})
