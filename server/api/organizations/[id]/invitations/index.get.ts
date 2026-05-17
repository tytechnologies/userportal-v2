// GET /api/organizations/:id/invitations?status=pending
//
// Org-owner-scoped invitation list. RLS allows brokerage owners /
// branch managers to SELECT invitations targeting their own org.

import { z } from 'zod'
import { orgInvitationsRepo } from '~~/server/repositories/orgInvitations.repo'

const querySchema = z.object({
  status: z.enum(['pending', 'accepted', 'declined', 'expired']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    return await orgInvitationsRepo.list({
      event,
      organizationId: id,
      status: query.status,
    })
  },
})
