// POST /api/organizations/:id/invitations
// Body: { email, full_name?, mobile_number?, org_role, branch_id?, notes? }
//
// Org-owner-scoped invite send. Email worker reads broker_invitations
// (joined to a token) and emails the invitation link.

import { z } from 'zod'
import { orgInvitationsRepo } from '~~/server/repositories/orgInvitations.repo'

const bodySchema = z.object({
  email: z.string().email().max(254),
  full_name: z.string().trim().max(200).nullable().optional(),
  mobile_number: z.string().trim().max(40).nullable().optional(),
  org_role: z.enum([
    'brokerage_owner',
    'branch_manager',
    'team_lead',
    'senior_agent',
    'junior_agent',
    'assistant',
  ]),
  branch_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    return await orgInvitationsRepo.create({ event, organizationId: id, input: body })
  },
})
