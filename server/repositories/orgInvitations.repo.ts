// Org invitations (owner-scoped wrapper around broker_invitations).
//
// The underlying table broker_invitations (mig 20260507000038) is
// admin-shared; this repo applies owner-scoped operations:
//   - list pending invites for an org the caller can manage
//   - create one invitation (invited_by = caller)
//   - revoke (status pending -> declined) via the B5 RPC

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { enqueueOutboundEmail, absoluteUrl } from '~~/server/utils/outboundEmail'

export type OrgInvitationCreateInput = {
  email: string
  full_name?: string | null
  mobile_number?: string | null
  org_role:
    | 'brokerage_owner'
    | 'branch_manager'
    | 'team_lead'
    | 'senior_agent'
    | 'junior_agent'
    | 'assistant'
  branch_id?: string | null
  notes?: string | null
}

const INVITATION_SELECT =
  'id, email, full_name, mobile_number, organization_id, branch_id, org_role, ' +
  'status, expires_at, accepted_at, accepted_by, declined_at, invited_by, ' +
  'notes, token, created_at'

export const orgInvitationsRepo = {
  async list({
    event,
    organizationId,
    status,
  }: {
    event: H3Event
    organizationId: string
    status?: 'pending' | 'accepted' | 'declined' | 'expired'
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('broker_invitations')
      .select(INVITATION_SELECT)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      logger.error(
        { err: error.message, op: 'orgInvitations.list', organizationId },
        'org_invitations_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async create({
    event,
    organizationId,
    input,
  }: {
    event: H3Event
    organizationId: string
    input: OrgInvitationCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const email = input.email.trim().toLowerCase()

    const { data, error } = await (client as any)
      .from('broker_invitations')
      .insert({
        email,
        full_name: input.full_name ?? null,
        mobile_number: input.mobile_number ?? null,
        organization_id: organizationId,
        branch_id: input.branch_id ?? null,
        org_role: input.org_role,
        invited_by: user.id,
        notes: input.notes ?? null,
      })
      .select(INVITATION_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'orgInvitations.create', organizationId, email },
        'org_invitations_create_failed',
      )
      // RLS denial = caller is not an org_owner / branch_manager of the org.
      if ((error as any).code === '42501' || /policy/i.test(error.message ?? '')) {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      // Repeat invite to same email = duplicate; existing flow on bulk
      // import enforces uniqueness with a partial index. Surface 409.
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'A pending invitation already exists for this email',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'organization.invitation_sent',
      entity: 'document',
      entityId: null,
      metadata: {
        organization_id: organizationId,
        invitation_id: data.id,
        email,
        org_role: data.org_role,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'org_invitations_create_activity_log_failed',
      )
    })

    // Fan out: enqueue invitation email with the accept-link token.
    enqueueInvitationEmail({
      invitationId: data.id,
      organizationId,
      email,
      token: data.token,
      orgRole: data.org_role,
      invitedBy: user.id,
      fullName: input.full_name ?? null,
      message: input.notes ?? null,
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'org_invitations_email_enqueue_failed',
      )
    })

    return data
  },

  async revoke({
    event,
    organizationId,
    invitationId,
  }: {
    event: H3Event
    organizationId: string
    invitationId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('org_invitation_revoke', {
      p_invitation_id: invitationId,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'orgInvitations.revoke', invitationId },
        'org_invitations_revoke_failed',
      )
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })
      }
      if (code === '22023') {
        throw createError({ statusCode: 409, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'organization.invitation_revoked',
      entity: 'document',
      entityId: null,
      metadata: { organization_id: organizationId, invitation_id: invitationId },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'org_invitations_revoke_activity_log_failed',
      )
    })

    return { ok: true, invitation_id: data }
  },
}

// =====================================================================
// Helper: enqueue invitation email
// =====================================================================
//
// Resolves org name + inviter name (best-effort), builds the
// accept-link URL (matches the existing /api/invitations/:token
// preview endpoint), and enqueues an org.invitation_sent template.
// Idempotent via dedupe_key='broker-invite:<invitation_id>'.

export async function enqueueInvitationEmail(input: {
  invitationId: string
  organizationId: string
  email: string
  token: string
  orgRole: string
  invitedBy: string | null
  fullName: string | null
  message: string | null
}): Promise<void> {
  const admin = getServerSupabaseAdmin()

  const [orgRes, inviterRes] = await Promise.all([
    (admin as any)
      .from('organizations')
      .select('name')
      .eq('id', input.organizationId)
      .maybeSingle(),
    input.invitedBy
      ? (admin as any)
          .from('profiles')
          .select('full_name')
          .eq('id', input.invitedBy)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const orgName: string = orgRes?.data?.name ?? 'an organization'
  const inviterName: string | null = inviterRes?.data?.full_name ?? null

  await enqueueOutboundEmail({
    to: input.email,
    toName: input.fullName,
    templateKind: 'org.invitation_sent',
    subject: `You're invited to join ${orgName}`,
    templateInput: {
      recipientName: input.fullName,
      actorName: inviterName,
      title: orgName,
      body: input.message,
      hrefAbsolute: absoluteUrl(`/invitations/${input.token}`),
    },
    dedupeKey: `broker-invite:${input.invitationId}`,
    referenceKind: 'broker_invitation',
    referenceId: input.invitationId,
    maxAttempts: 5,
    createdBy: input.invitedBy,
  })
}
