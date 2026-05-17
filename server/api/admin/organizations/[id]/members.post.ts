// Admin — add a member to an organization.
//
// POST /api/admin/organizations/:id/members
// Auth: admin.
//
// Body: { user_id, org_role, branch_id?, status? }
//
// Status defaults to 'active' for admin-created memberships
// (admins skip the invite/accept flow). The end-user invite flow
// is its own endpoint, deferred to a follow-up.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

const ROLES = [
  'brokerage_owner',
  'branch_manager',
  'team_lead',
  'senior_agent',
  'junior_agent',
  'assistant',
] as const

const bodySchema = z.object({
  user_id:   z.string().uuid(),
  org_role:  z.enum(ROLES),
  branch_id: z.string().uuid().nullable().optional(),
  status:    z.enum(['active', 'pending', 'trial']).optional().default('active'),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const orgId = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(orgId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid organization id' })
    }
    const b = body as z.infer<typeof bodySchema>

    const supabase = getServerSupabaseAdmin()

    const { data: org } = await (supabase as any)
      .from('organizations')
      .select('id')
      .eq('id', orgId)
      .maybeSingle()
    if (!org) throw createError({ statusCode: 404, statusMessage: 'Organization not found' })

    const { data: prof } = await (supabase as any)
      .from('profiles')
      .select('id, full_name')
      .eq('id', b.user_id)
      .maybeSingle()
    if (!prof) throw createError({ statusCode: 400, statusMessage: 'Member profile not found' })

    // Validate branch belongs to this org if specified.
    if (b.branch_id) {
      const { data: branch } = await (supabase as any)
        .from('organization_branches')
        .select('id')
        .eq('id', b.branch_id)
        .eq('organization_id', orgId)
        .maybeSingle()
      if (!branch) {
        throw createError({ statusCode: 400, statusMessage: 'Branch does not belong to this organization' })
      }
    }

    const insertPayload: Record<string, any> = {
      organization_id: orgId,
      user_id:         b.user_id,
      org_role:        b.org_role,
      status:          b.status,
      branch_id:       b.branch_id ?? null,
    }
    if (b.status === 'active') insertPayload.joined_at = new Date().toISOString()

    const { data: created, error } = await (supabase as any)
      .from('organization_memberships')
      .insert(insertPayload)
      .select('id, user_id, org_role, status, branch_id, joined_at')
      .single()

    if (error) {
      if (error.code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `${prof.full_name || 'User'} already has the role "${b.org_role}" in this organization`,
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Notify the new member so they see the org appear in their UI.
    await (supabase as any).rpc('notify', {
      p_recipient_user_id: b.user_id,
      p_kind:              'org.member_added',
      p_title:             'Added to an organization',
      p_body:              `You were added as ${b.org_role.replace(/_/g, ' ')}.`,
      p_href:              '/organization',
      p_metadata:          { organization_id: orgId, membership_id: created.id },
    }).catch((err: any) => console.warn('[admin/organizations.members.post] notify failed', err))

    await (supabase as any).rpc('log_activity', {
      p_action:   'org.member_added',
      p_metadata: { organization_id: orgId, user_id: b.user_id, org_role: b.org_role },
    }).catch((err: any) => console.warn('[admin/organizations.members.post] log_activity failed', err))

    return { membership: created }
  },
})
