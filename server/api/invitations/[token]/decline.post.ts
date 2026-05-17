// Decline a broker invitation.
//
// POST /api/invitations/:token/decline
// Anonymous-callable (token is the auth). The recipient might not
// have an account yet — declining doesn't require sign-in.
//
// No-op when the invitation is already accepted/declined/expired.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineEventHandler(async (event) => {
  const token = (getRouterParam(event, 'token') || '').toLowerCase().trim()
  if (!UUID_RE.test(token)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid invitation token' })
  }

  const supabase = getServerSupabaseAdmin()

  const { data: inv, error: invErr } = await (supabase as any)
    .from('broker_invitations')
    .select('id, status, invited_by, organization_id, org_role, email')
    .eq('token', token)
    .maybeSingle()
  if (invErr) throw createError({ statusCode: 500, statusMessage: invErr.message })
  if (!inv)   throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })

  if (inv.status !== 'pending') {
    return { ok: true, status: inv.status, already: true }
  }

  await (supabase as any)
    .from('broker_invitations')
    .update({ status: 'declined', declined_at: new Date().toISOString() })
    .eq('id', inv.id)
    .eq('status', 'pending')   // double-check at write time

  // Notify the inviter so they know.
  if (inv.invited_by) {
    await (supabase as any).rpc('notify', {
      p_recipient_user_id: inv.invited_by,
      p_kind:              'org.invitation_declined',
      p_title:             'Invitation declined',
      p_body:              `${inv.email} declined your invitation.`,
      p_href:              '/admin?tab=broker-invitations',
      p_metadata:          { invitation_id: inv.id, organization_id: inv.organization_id },
    }).catch((err: any) =>
      console.warn('[/api/invitations/:token/decline] notify failed', err),
    )
  }

  await (supabase as any).rpc('log_activity', {
    p_action:   'broker.invitation_declined',
    p_metadata: { invitation_id: inv.id, organization_id: inv.organization_id },
  }).catch((err: any) =>
    console.warn('[/api/invitations/:token/decline] log_activity failed', err),
  )

  return { ok: true, status: 'declined' }
})
