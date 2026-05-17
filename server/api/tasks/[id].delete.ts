// Delete a CRM task. RLS allows owner or tasks.write.all only.
// Snapshot-then-delete + audit emission live in the repo.

import { tasksRepo } from '~~/server/repositories/tasks.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid task id' })
    }
    return await tasksRepo.delete({ event, id })
  },
})
