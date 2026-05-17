// GET /api/admin/platform-settings?organization_id=...
//
// Without organization_id: returns global rows only (organization_id IS NULL).
// With organization_id: returns the per-tenant rows for that org.
//
// Returns the union under the "items" key, plus an "organization_id"
// echo so the UI doesn't lose track of which scope it requested.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  organization_id: z.string().uuid().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('platform_settings')
      .select('key, value, description, organization_id, updated_by, updated_at')
      .order('key', { ascending: true })
    if (query.organization_id) {
      q = q.eq('organization_id', query.organization_id)
    } else {
      q = q.is('organization_id', null)
    }
    const { data, error } = await q
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return {
      items: data ?? [],
      organization_id: query.organization_id ?? null,
    }
  },
})
