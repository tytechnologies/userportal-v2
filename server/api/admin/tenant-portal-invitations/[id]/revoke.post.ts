// Admin: revoke a pending tenant portal invitation.
//
// POST /api/admin/tenant-portal-invitations/[id]/revoke
// Body: { reason: string }
//
// Calls revoke_tenant_portal_invitation() RPC. Idempotent on already-
// revoked invitations; rejects already-accepted ones (the binding has
// already been used; revoke would mislead the audit log). To "revoke"
// an accepted invitation, the operator should instead clear
// lease_parties.user_id (a separate, manager-only operation).

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
      'revoke_tenant_portal_invitation',
      { p_invitation_id: invitationId, p_reason: body.reason },
    )

    if (error) {
      logger.error(
        {
          err: error.message,
          op: 'admin.tenant_portal_invitations.revoke',
          invitation_id: invitationId,
        },
        'tenant_portal_invitation_revoke_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: error.message })
      }
      // The RPC raises a plain RAISE EXCEPTION when an accepted invite
      // is being revoked â€” propagate as 409.
      if (/already accepted/i.test(error.message ?? '')) {
        throw createError({ statusCode: 409, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not revoke invitation' })
    }

    await logActivity({
      event,
      action: 'tenant_portal_invitation.revoked',
      entity: 'tenant_portal_invitation' as any,
      entityId: invitationId,
      metadata: { reason: body.reason },
    })

    return { invitation_id: invitationId, revoked: true }
  },
})
