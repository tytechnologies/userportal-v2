// Admin — add a branch to an organization.
//
// POST /api/admin/organizations/:id/branches
// Auth: admin.
//
// Body: { name, slug, address?, manager_user_id? }

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const bodySchema = z.object({
  name:            z.string().trim().min(2).max(120),
  slug:            z.string().trim().min(2).max(64).regex(SLUG_RE,
                     'Slug must be lowercase alphanumeric + hyphens'),
  address:         z.string().trim().max(500).nullable().optional(),
  manager_user_id: z.string().uuid().nullable().optional(),
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

    // Confirm org exists.
    const { data: org } = await (supabase as any)
      .from('organizations')
      .select('id')
      .eq('id', orgId)
      .maybeSingle()
    if (!org) throw createError({ statusCode: 404, statusMessage: 'Organization not found' })

    // Validate manager profile if supplied.
    if (b.manager_user_id) {
      const { data: prof } = await (supabase as any)
        .from('profiles')
        .select('id')
        .eq('id', b.manager_user_id)
        .maybeSingle()
      if (!prof) throw createError({ statusCode: 400, statusMessage: 'Manager profile not found' })
    }

    const { data: created, error } = await (supabase as any)
      .from('organization_branches')
      .insert({
        organization_id: orgId,
        name:            b.name,
        slug:            b.slug,
        address:         b.address ?? null,
        manager_user_id: b.manager_user_id ?? null,
      })
      .select('id, name, slug, address, manager_user_id, active')
      .single()

    if (error) {
      if (error.code === '23505') {
        throw createError({ statusCode: 409, statusMessage: `Slug "${b.slug}" already in use for this organization` })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await (supabase as any).rpc('log_activity', {
      p_action:   'org.branch_created',
      p_metadata: { organization_id: orgId, branch_id: created.id, slug: created.slug },
    }).catch((err: any) => console.warn('[admin/organizations.branches.post] log_activity failed', err))

    return { branch: created }
  },
})
