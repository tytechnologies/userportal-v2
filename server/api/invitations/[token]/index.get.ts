// Public-ish invitation preview.
//
// GET /api/invitations/:token
//
// Anonymous-callable. Returns the minimum information the recipient
// needs to decide whether to accept: organization name + slug,
// branch name (if any), org_role, status, expires_at. Does NOT
// reveal who invited them or other org members — the invitation
// is keyed on a secret token, but the response is intentionally
// minimal so a leaked token doesn't expose org internals.
//
// Status responses:
//   200 + invitation payload — pending invitation, ready to accept
//   200 + { status: 'accepted' / 'declined' / 'expired' } — terminal
//   404                       — token not found

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineEventHandler(async (event) => {
  const token = (getRouterParam(event, 'token') || '').toLowerCase().trim()
  if (!UUID_RE.test(token)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid invitation token' })
  }

  // Service role: broker_invitations is admin-only RLS. Anon visitors
  // hitting this endpoint need to read their own invitation by
  // token; service role with a token check is the chokepoint.
  const supabase = getServerSupabaseAdmin()

  const { data: inv, error } = await (supabase as any)
    .from('broker_invitations')
    .select('id, email, full_name, organization_id, branch_id, org_role, status, expires_at, created_at')
    .eq('token', token)
    .maybeSingle()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  if (!inv)  throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })

  // If the row is past its expiry but still 'pending', surface as
  // 'expired' to the caller — the daily prune cron flips state, but
  // we don't want to wait until next 04:20 UTC for the UI to update.
  let effectiveStatus = inv.status
  if (effectiveStatus === 'pending' && inv.expires_at && new Date(inv.expires_at) < new Date()) {
    effectiveStatus = 'expired'
  }

  // Resolve organization + branch names (public-safe — both have
  // public-ish naming conventions in the existing org admin tab).
  const [orgRes, branchRes] = await Promise.all([
    (supabase as any)
      .from('organizations')
      .select('id, name, slug, verified')
      .eq('id', inv.organization_id)
      .maybeSingle(),
    inv.branch_id
      ? (supabase as any)
          .from('organization_branches')
          .select('id, name, slug')
          .eq('id', inv.branch_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return {
    token:      token,
    status:     effectiveStatus,
    email:      inv.email,
    full_name:  inv.full_name,
    org_role:   inv.org_role,
    expires_at: inv.expires_at,
    organization: orgRes?.data ?? null,
    branch:       branchRes?.data ?? null,
  }
})
