// Delete a CRM note. RLS allows owner or notes.write.all only.
// Snapshot-then-delete + audit emission live in the repo.

import { notesRepo } from '~~/server/repositories/notes.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid note id' })
    }
    return await notesRepo.delete({ event, id })
  },
})
