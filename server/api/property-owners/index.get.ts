// GET /api/property-owners
// Lists owners visible to the caller (admin/manager → all; owner → self via RLS).

import { ownersRepo } from '~~/server/repositories/owners.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    return await ownersRepo.list({ event })
  },
})
