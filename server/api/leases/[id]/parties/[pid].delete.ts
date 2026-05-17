// DELETE /api/leases/:id/parties/:pid
// Allowed only when lease.status='draft' (RLS-enforced).

import { leasesRepo } from '~~/server/repositories/leases.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const leaseId = getRouterParam(event, 'id')
    const partyId = getRouterParam(event, 'pid')
    if (!leaseId || !/^[0-9a-f-]{36}$/i.test(leaseId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }
    if (!partyId || !/^[0-9a-f-]{36}$/i.test(partyId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid party id' })
    }
    return await leasesRepo.removeParty({ event, leaseId, partyId })
  },
})
