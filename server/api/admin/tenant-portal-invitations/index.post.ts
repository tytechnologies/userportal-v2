// Admin: issue a tenant portal invitation.
//
// POST /api/admin/tenant-portal-invitations
// Body: { lease_party_id: uuid, invite_email?: string, expires_in_days?: number }
//
// Generates a single-use cleartext token (never logged), stores its
// sha256 hash via issue_tenant_portal_invitation() RPC, and emails the
// tenant a portal accept-invite link. The cleartext token is returned
// to the caller too so the admin UI can offer a "copy invite link"
// fallback when email is misconfigured (RESEND_API_KEY unset).
//
// Permission: admin / manager (RBAC checked inside the RPC). The RPC's
// SECURITY DEFINER + has_permission() check is the authoritative
// boundary; this handler also requireRole() short-circuits for
// faster-failing UX.

import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { sendEmail, renderEmail } from '~~/server/utils/email'

const bodySchema = z.object({
  lease_party_id: z.string().uuid(),
  invite_email: z.string().trim().email().max(320).optional(),
  expires_in_days: z.number().int().min(1).max(90).optional(),
})

// 48 random bytes â†’ 64 base64url chars. Plenty of entropy; URL-safe so
// it lives in the accept-invite path without escaping.
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
    // Defense-in-depth â€” the RPC also enforces this. requireRole is
    // hierarchical: 'manager' admits admin + manager.
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()

    // 1. Pull the party + lease + unit context. We need this BEFORE
    //    issuing the invite so we can a) decide on a default email
    //    (lease_parties.external_email), b) render a useful subject
    //    line, c) abort early on shape errors instead of mid-flight.
    const { data: party, error: partyErr } = await (admin as any)
      .from('lease_parties')
      .select(`
        id,
        lease_id,
        role,
        user_id,
        external_name,
        external_email,
        leases:lease_id (
          id,
          unit_id,
          units:unit_id ( id, unit_number, building_id )
        )
      `)
      .eq('id', body.lease_party_id)
      .single()

    if (partyErr || !party) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Lease party not found',
      })
    }
    if (party.role !== 'tenant') {
      throw createError({
        statusCode: 422,
        statusMessage: 'Only tenant parties can be invited to the portal',
      })
    }
    if (party.user_id) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Party is already bound to a user',
      })
    }

    const inviteEmail = (body.invite_email ?? party.external_email ?? '').trim()
    if (!inviteEmail) {
      throw createError({
        statusCode: 422,
        statusMessage:
          'No invite_email provided and lease_parties.external_email is empty',
      })
    }

    const expiresInDays = body.expires_in_days ?? 14
    const token = generateToken()

    // 2. Issue via the RPC â€” service-role client so SECURITY DEFINER
    //    runs cleanly. The RPC handles uniqueness (auto-revokes any
    //    prior active invitation) and stamps created_by from auth.uid()
    //    (which the service-role client doesn't carry, so the audit
    //    layer below records the actor explicitly).
    const { data: rpcRes, error: rpcErr } = await (admin as any).rpc(
      'issue_tenant_portal_invitation',
      {
        p_lease_party_id: body.lease_party_id,
        p_invite_email: inviteEmail,
        p_token: token,
        p_expires_in_days: expiresInDays,
      },
    )

    if (rpcErr) {
      logger.error(
        {
          err: rpcErr.message,
          op: 'admin.tenant_portal_invitations.issue',
          lease_party_id: body.lease_party_id,
        },
        'tenant_portal_invitation_issue_failed',
      )
      // 42501 (permission) â†’ surface as 403; everything else 500.
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
      lease_party_id: string
      expires_at: string
      invite_email: string
    }

    // 3. Build the accept-invite URL on the public website. Read host
    //    from env so dev / staging / prod all resolve correctly without
    //    a redeploy.
    const websiteBase = (
      process.env.PUBLIC_SITE_URL ??
      process.env.PUBLIC_WEBSITE_URL ??
      'https://www.housinginteractive.com.ph'
    ).replace(/\/$/, '')
    const acceptUrl = `${websiteBase}/portal/accept-invite/${encodeURIComponent(token)}`

    // 4. Email â€” uses the existing Resend wrapper. When the API key is
    //    unset (e.g. local dev) sendEmail() logs and returns; we still
    //    return success because the cleartext token is in the response
    //    body for copy-paste.
    const tenantName = party.external_name ?? null
    const unit = (party as any).leases?.units
    const unitLabel =
      unit?.unit_number ? `Unit ${unit.unit_number}` : 'your rental unit'

    const tpl = renderEmail('tenant_portal.invitation', {
      recipientName: tenantName,
      actorName: user?.email ?? null,
      title: `Access your tenant portal`,
      body: `You've been invited to manage ${unitLabel} on Housing Interactive. The link below is unique to you and expires in ${expiresInDays} days.`,
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
          op: 'admin.tenant_portal_invitations.email',
          invitation_id: result.invitation_id,
        },
        'tenant_portal_invitation_email_failed',
      )
      // We still surface success â€” the cleartext token is in the
      // response body so the admin can manually deliver. The retry
      // path is "issue a new invitation" rather than "retry email".
    }

    // 5. Audit. Token is NEVER logged.
    await logActivity({
      event,
      action: 'tenant_portal_invitation.issued',
      entity: 'lease_party' as any,
      entityId: body.lease_party_id,
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
      lease_party_id: result.lease_party_id,
      invite_email: result.invite_email,
      expires_at: result.expires_at,
      // Returned ONCE on creation so the admin UI can show a "copy invite
      // link" button. Never persisted, never re-fetchable, never logged.
      accept_url: acceptUrl,
      email_delivered: emailDelivered,
    }
  },
})
