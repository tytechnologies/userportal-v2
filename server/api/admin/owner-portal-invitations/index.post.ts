// Admin: issue an owner portal invitation.
//
// POST /api/admin/owner-portal-invitations
// Body: { property_owner_id: uuid, invite_email?: string, expires_in_days?: number }
//
// Mirror of POST /api/admin/tenant-portal-invitations. Generates a
// 48-byte cleartext token (never logged), stores its sha256 hash via
// issue_owner_portal_invitation() RPC, and emails the owner a portal
// accept-invite link. Returns the cleartext token once so the admin UI
// can offer a "copy invite link" fallback when email is misconfigured.

import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { sendEmail, renderEmail } from '~~/server/utils/email'

const bodySchema = z.object({
  property_owner_id: z.string().uuid(),
  invite_email: z.string().trim().email().max(320).optional(),
  expires_in_days: z.number().int().min(1).max(90).optional(),
})

function generateToken(): string {
  return randomBytes(48)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()

    const { data: owner, error: ownerErr } = await (admin as any)
      .from('property_owners')
      .select('id, user_id, external_name, external_email, contact_id')
      .eq('id', body.property_owner_id)
      .single()

    if (ownerErr || !owner) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Property owner not found',
      })
    }
    if (owner.user_id) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Owner is already bound to a user',
      })
    }

    const inviteEmail = (body.invite_email ?? owner.external_email ?? '').trim()
    if (!inviteEmail) {
      throw createError({
        statusCode: 422,
        statusMessage:
          'No invite_email provided and property_owners.external_email is empty',
      })
    }

    const expiresInDays = body.expires_in_days ?? 14
    const token = generateToken()

    const { data: rpcRes, error: rpcErr } = await (admin as any).rpc(
      'issue_owner_portal_invitation',
      {
        p_property_owner_id: body.property_owner_id,
        p_invite_email: inviteEmail,
        p_token: token,
        p_expires_in_days: expiresInDays,
      },
    )

    if (rpcErr) {
      logger.error(
        {
          err: rpcErr.message,
          op: 'admin.owner_portal_invitations.issue',
          property_owner_id: body.property_owner_id,
        },
        'owner_portal_invitation_issue_failed',
      )
      const code = (rpcErr as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: rpcErr.message })
      }
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not issue invitation',
      })
    }

    const result = rpcRes as {
      invitation_id: string
      property_owner_id: string
      expires_at: string
      invite_email: string
    }

    const websiteBase = (
      process.env.PUBLIC_SITE_URL ??
      process.env.PUBLIC_WEBSITE_URL ??
      'https://www.housinginteractive.com.ph'
    ).replace(/\/$/, '')
    const acceptUrl = `${websiteBase}/portal/owner/accept-invite/${encodeURIComponent(token)}`

    const ownerName = owner.external_name ?? null
    const tpl = renderEmail('owner_portal.invitation', {
      recipientName: ownerName,
      actorName: user?.email ?? null,
      title: 'Access your owner portal',
      body: `You've been invited to your owner portal on Housing Interactive â€” view your units, statements, dues, and disbursements. The link below is unique to you and expires in ${expiresInDays} days.`,
      hrefAbsolute: acceptUrl,
    })

    let emailDelivered = true
    try {
      await sendEmail({
        to: result.invite_email,
        subject: tpl.subject,
        html: tpl.html,
      })
    } catch (err: any) {
      emailDelivered = false
      logger.warn(
        {
          err: err?.message,
          op: 'admin.owner_portal_invitations.email',
          invitation_id: result.invitation_id,
        },
        'owner_portal_invitation_email_failed',
      )
    }

    await logActivity({
      event,
      action: 'owner_portal_invitation.issued',
      entity: 'property_owner' as any,
      entityId: body.property_owner_id,
      metadata: {
        invitation_id: result.invitation_id,
        invite_email: result.invite_email,
        expires_at: result.expires_at,
        expires_in_days: expiresInDays,
        email_delivered: emailDelivered,
      },
    })

    return {
      invitation_id: result.invitation_id,
      property_owner_id: result.property_owner_id,
      invite_email: result.invite_email,
      expires_at: result.expires_at,
      accept_url: acceptUrl,
      email_delivered: emailDelivered,
    }
  },
})
