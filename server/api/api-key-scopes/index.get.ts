// GET /api/api-key-scopes
// Lists the scope catalog so the UI can render a picker.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  category: z.string().trim().max(40).optional(),
  enabled: z.union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')]).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('api_key_scopes')
      .select('id, scope, description, category, enabled, requires_admin')
      .order('category', { ascending: true })
      .order('scope', { ascending: true })
    if (query.category) q = q.eq('category', query.category)
    if (query.enabled !== undefined) {
      const wantEnabled = query.enabled === '1' || query.enabled === 'true'
      q = q.eq('enabled', wantEnabled)
    }
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
