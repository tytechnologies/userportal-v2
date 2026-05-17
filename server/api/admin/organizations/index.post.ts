// Admin — create a new organization.
//
// POST /api/admin/organizations
// Auth: admin (admin.access permission).
// Uses service role because organizations.INSERT has no policy
// (mig 26 restricts INSERT/DELETE to service role) — admin gate
// upstream prevents any non-admin from reaching this code path.
//
// Body: { name, slug, owner_user_id, description?, verified?, branding? }
//
// On success: also seeds the owner as a brokerage_owner active
// membership so the dashboard works immediately.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const bodySchema = z.object({
  name:           z.string().trim().min(2).max(120),
  slug:           z.string().trim().min(2).max(64).regex(SLUG_RE,
                    'Slug must be lowercase alphanumeric + hyphens'),
  owner_user_id:  z.string().uuid(),
  description:    z.string().trim().max(2000).optional().nullable(),
  verified:       z.boolean().optional().default(false),
  branding:       z.record(z.any()).optional().default({}),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    const b = body as z.infer<typeof bodySchema>

    const supabase = getServerSupabaseAdmin()

    // Confirm the owner profile exists. Avoids a confusing FK error
    // if the user types a stale uuid.
    const { data: owner, error: ownerErr } = await (supabase as any)
      .from('profiles')
      .select('id, full_name')
      .eq('id', b.owner_user_id)
      .maybeSingle()
    if (ownerErr) throw createError({ statusCode: 500, statusMessage: ownerErr.message })
    if (!owner) throw createError({ statusCode: 400, statusMessage: 'Owner profile not found' })

    // Slug uniqueness pre-check for a clean error message — DB has a
    // UNIQUE constraint as the real guard.
    const { data: existing } = await (supabase as any)
      .from('organizations')
      .select('id')
      .eq('slug', b.slug)
      .maybeSingle()
    if (existing) {
      throw createError({ statusCode: 409, statusMessage: `Slug "${b.slug}" already in use` })
    }

    const { data: created, error: createErr } = await (supabase as any)
      .from('organizations')
      .insert({
        name:          b.name,
        slug:          b.slug,
        owner_user_id: b.owner_user_id,
        description:   b.description ?? null,
        verified:      b.verified,
        branding:      b.branding ?? {},
      })
      .select('id, name, slug, owner_user_id')
      .single()
    if (createErr) throw createError({ statusCode: 500, statusMessage: createErr.message })

    // Seed the owner as a brokerage_owner active membership. Without
    // this, the org has no members and the dashboard renders empty
    // for the owner — confusing UX.
    const { error: memberErr } = await (supabase as any)
      .from('organization_memberships')
      .insert({
        organization_id: created.id,
        user_id:         b.owner_user_id,
        org_role:        'brokerage_owner',
        status:          'active',
        joined_at:       new Date().toISOString(),
      })
    if (memberErr) {
      // Soft warn. The org exists; the membership row is recoverable.
      console.warn('[admin/organizations.post] owner membership seed failed', memberErr)
    }

    // Audit. Free-form action string per memory rule.
    await (supabase as any).rpc('log_activity', {
      p_action:    'org.created',
      p_metadata:  {
        organization_id: created.id,
        owner_user_id:   created.owner_user_id,
        slug:            created.slug,
      },
    }).catch((err: any) => console.warn('[admin/organizations.post] log_activity failed', err))

    return { organization: created }
  },
})
