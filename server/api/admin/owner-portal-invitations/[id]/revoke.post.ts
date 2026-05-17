// Admin: revoke a pending owner portal invitation.
//
// POST /api/admin/owner-portal-invitations/[id]/revoke
// Body: { reason: string }
//
// Idempotent on already-revoked; rejects already-accepted (clear
// property_owners.user_id separately if you really need to unbind).
// Mirror of the tenant revoke endpoint.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const invitationId = getRouterParam(event, 'id')
    if (!invitationId || !/^[0-9a-f-]{36}$/i.test(invitationId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid invitation id' })
    }

    const admin = getServerSupabaseAdmin()
    const { error } = await (admin as any).rpc(
      'revoke_owner_portal_invitation',
      { p_invitation_id: invitationId, p_reason: body.reason },
    )

    if (error) {
      logger.error(
        {
          err: error.message,
          op: 'admin.owner_portal_invitations.revoke',
          invitation_id: invitationId,
        },
        'owner_portal_invitation_revoke_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: error.message })
      }
      if (/already accepted/i.test(error.message ?? '')) {
        throw createError({ statusCode: 409, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not revoke invitation' })
    }

    await logActivity({
      event,
      action: 'owner_portal_invitation.revoked',
      entity: 'owner_portal_invitation' as any,
      entityId: invitationId,
      metadata: { reason: body.reason },
    })

    return { invitation_id: invitationId, revoked: true }
  },
})
