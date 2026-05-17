// DELETE /api/admin/units/:id
// Soft-delete: sets status='inactive'. The hard DELETE is RLS-blocked.

import { unitsRepo } from '~~/server/repositories/units.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid unit id' })
    }
    return await unitsRepo.softDelete({ event, id })
  },
})
