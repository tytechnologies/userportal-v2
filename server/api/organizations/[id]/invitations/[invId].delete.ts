// DELETE /api/organizations/:id/invitations/:invId
//
// Owner revokes a pending invitation. Calls the org_invitation_revoke
// RPC which validates ownership and lifecycle (pending only).

import { orgInvitationsRepo } from '~~/server/repositories/orgInvitations.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const orgId = getRouterParam(event, 'id')
    const invitationId = getRouterParam(event, 'invId')
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    if (!invitationId || !/^[0-9a-f-]{36}$/i.test(invitationId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid invitation id' })
    }
    return await orgInvitationsRepo.revoke({
      event,
      organizationId: orgId,
      invitationId,
    })
  },
})
