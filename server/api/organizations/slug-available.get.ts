// Slug availability preview for the onboarding form. Lightweight —
// just a boolean. Doesn't reserve the slug; the real uniqueness
// guard is the DB UNIQUE index hit at INSERT time.
//
// GET /api/organizations/slug-available?slug=acme-realty
// Response: { available: boolean }

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  slug: z.string().trim().min(2).max(64),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    // Direct SELECT would be RLS-blocked for non-members of the org —
    // would always return "available" even when taken. The RPC bypasses
    // RLS and exposes only a boolean.
    const { data, error } = await (supabase as any).rpc(
      'organization_slug_taken',
      { p_slug: q.slug },
    )

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    setHeader(event, 'Cache-Control', 'no-store')
    return { available: data === false }
  },
})
