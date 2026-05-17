// Admin — update organization metadata.
//
// PATCH /api/admin/organizations/:id
// Auth: admin.
//
// Body: any subset of { name, description, verified, owner_user_id, branding }.
// Slug is intentionally NOT mutable — it's part of the contract for
// future public org pages and would invalidate cached SEO.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

const bodySchema = z.object({
  name:          z.string().trim().min(2).max(120).optional(),
  description:   z.string().trim().max(2000).nullable().optional(),
  verified:      z.boolean().optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  branding:      z.record(z.any()).optional(),
}).strict()

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
    if (Object.keys(b).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const supabase = getServerSupabaseAdmin()

    // If owner is changing, validate the new profile exists.
    if (b.owner_user_id !== undefined && b.owner_user_id !== null) {
      const { data: prof } = await (supabase as any)
        .from('profiles')
        .select('id')
        .eq('id', b.owner_user_id)
        .maybeSingle()
      if (!prof) throw createError({ statusCode: 400, statusMessage: 'Owner profile not found' })
    }

    const { data: updated, error } = await (supabase as any)
      .from('organizations')
      .update(b)
      .eq('id', orgId)
      .select('id, name, slug, verified, owner_user_id, description')
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Organization not found' })

    await (supabase as any).rpc('log_activity', {
      p_action:   'org.updated',
      p_metadata: { organization_id: orgId, changed: Object.keys(b) },
    }).catch((err: any) => console.warn('[admin/organizations.patch] log_activity failed', err))

    return { organization: updated }
  },
})
