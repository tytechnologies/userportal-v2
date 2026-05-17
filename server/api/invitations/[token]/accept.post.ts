// Accept a broker invitation.
//
// POST /api/invitations/:token/accept
// Auth: required. The caller must be the email address the
// invitation was sent to (case-insensitive match).
//
// Side effects:
//   1. Match auth.uid() → profiles.id by email
//   2. INSERT organization_memberships row (status='active', joined_at=now())
//      OR no-op if the user is already a member of the target org
//   3. Stamp broker_invitations.{accepted_at, accepted_by, status='accepted'}
//   4. notify() the inviter that the invitation was accepted
//   5. log_activity('broker.invitation_accepted')
//
// All idempotent — re-calling on an already-accepted invitation
// returns the same membership row without errors.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { serverSupabaseUser } from '../../../utils/sbUser'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineEventHandler(async (event) => {
  const token = (getRouterParam(event, 'token') || '').toLowerCase().trim()
  if (!UUID_RE.test(token)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid invitation token' })
  }

  const user = await serverSupabaseUser(event)
  if (!user?.id) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Sign in to accept this invitation',
    })
  }

  const supabase = getServerSupabaseAdmin()

  // Pull the invitation by token.
  const { data: inv, error: invErr } = await (supabase as any)
    .from('broker_invitations')
    .select('id, email, organization_id, branch_id, org_role, status, expires_at, invited_by')
    .eq('token', token)
    .maybeSingle()
  if (invErr) throw createError({ statusCode: 500, statusMessage: invErr.message })
  if (!inv)   throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })

  // Lifecycle gate.
  if (inv.status === 'accepted') {
    return { ok: true, status: 'accepted', already: true }
  }
  if (inv.status === 'declined') {
    throw createError({ statusCode: 409, statusMessage: 'Invitation was declined' })
  }
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
    // Mark expired now if the prune cron hasn't fired yet.
    await (supabase as any)
      .from('broker_invitations')
      .update({ status: 'expired' })
      .eq('id', inv.id)
      .eq('status', 'pending')
    throw createError({ statusCode: 410, statusMessage: 'Invitation has expired' })
  }

  // Email match. Caller's auth email must match the invitation.
  // Case-insensitive — email addresses are not case-sensitive in
  // practice, and we lowercase on staging.
  const callerEmail = (user.email || '').trim().toLowerCase()
  const invEmail    = (inv.email   || '').trim().toLowerCase()
  if (!callerEmail || callerEmail !== invEmail) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Invitation is for a different email address',
    })
  }

  // Look up profile by id — it should exist for any authenticated
  // Supabase user. If it doesn't, the platform's signup-trigger
  // failed; surface that explicitly.
  const { data: profile } = await (supabase as any)
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Profile row missing for this user; contact support',
    })
  }

  // Insert membership if not already present. The
  // organization_memberships UNIQUE on (org, user, role) will
  // protect against duplicate-role inserts.
  const { data: existingMembership } = await (supabase as any)
    .from('organization_memberships')
    .select('id, status, org_role')
    .eq('user_id', profile.id)
    .eq('organization_id', inv.organization_id)
    .eq('org_role', inv.org_role)
    .maybeSingle()

  let membershipId = existingMembership?.id ?? null

  if (!membershipId) {
    const { data: created, error: memErr } = await (supabase as any)
      .from('organization_memberships')
      .insert({
        organization_id: inv.organization_id,
        user_id:         profile.id,
        branch_id:       inv.branch_id,
        org_role:        inv.org_role,
        status:          'active',
        joined_at:       new Date().toISOString(),
        invited_by:      inv.invited_by,
      })
      .select('id')
      .single()
    if (memErr) {
      throw createError({ statusCode: 500, statusMessage: memErr.message })
    }
    membershipId = created.id
  }

  // Mark invitation accepted.
  await (supabase as any)
    .from('broker_invitations')
    .update({
      status:      'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by: profile.id,
    })
    .eq('id', inv.id)

  // Notify the inviter (best-effort).
  if (inv.invited_by) {
    await (supabase as any).rpc('notify', {
      p_recipient_user_id: inv.invited_by,
      p_kind:              'org.invitation_accepted',
      p_title:             'Invitation accepted',
      p_body:              `${profile.full_name || callerEmail} joined your organization.`,
      p_href:              '/organization',
      p_metadata:          {
        invitation_id: inv.id,
        membership_id: membershipId,
        org_role:      inv.org_role,
      },
    }).catch((err: any) =>
      console.warn('[/api/invitations/:token/accept] notify failed', err),
    )
  }

  await (supabase as any).rpc('log_activity', {
    p_action:   'broker.invitation_accepted',
    p_metadata: {
      invitation_id:   inv.id,
      organization_id: inv.organization_id,
      org_role:        inv.org_role,
      profile_id:      profile.id,
    },
  }).catch((err: any) =>
    console.warn('[/api/invitations/:token/accept] log_activity failed', err),
  )

  return { ok: true, status: 'accepted', membership_id: membershipId }
})
