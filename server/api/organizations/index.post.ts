// Self-serve brokerage creation. Any authenticated user can create
// their own organization and is auto-bootstrapped as the
// brokerage_owner via the create_organization_as_owner() RPC. Non-admin
// users hit a lifetime cap of 3 orgs; admins are exempt.
//
// POST /api/organizations
// Body: { name, slug, description? }
// Response: { organization: { id, name, slug, description, created_at } }
//
// Distinct from the admin endpoint at /api/admin/organizations which
// lets a platform admin provision orgs on behalf of arbitrary users.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const bodySchema = z.object({
  name:        z.string().trim().min(2).max(120),
  slug:        z.string().trim().min(2).max(64).regex(SLUG_RE,
                 'Slug must be lowercase alphanumeric + hyphens'),
  description: z.string().trim().max(2000).optional().nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any).rpc(
      'create_organization_as_owner',
      {
        p_name:        b.name,
        p_slug:        b.slug,
        p_description: b.description ?? null,
      },
    )

    if (error) {
      // Map known Postgres errors to clean HTTP statuses.
      const code = (error as any).code as string | undefined
      const msg  = error.message ?? 'Could not create organization'
      if (code === '23505') throw createError({ statusCode: 409, statusMessage: msg })
      if (code === '53400') throw createError({ statusCode: 429, statusMessage: msg })
      if (code === '22023') throw createError({ statusCode: 400, statusMessage: msg })
      if (code === '42501') throw createError({ statusCode: 401, statusMessage: msg })
      throw createError({ statusCode: 500, statusMessage: msg })
    }

    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      throw createError({ statusCode: 500, statusMessage: 'Org created but no row returned' })
    }

    return { organization: row }
  },
})
