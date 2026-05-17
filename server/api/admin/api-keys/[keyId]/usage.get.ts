// GET /api/admin/api-keys/:keyId/usage?since=ISO&limit=200
// Returns the recent usage feed for a key.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const id = getRouterParam(event, 'keyId')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid key id' })
    }

    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('api_key_usage')
      .select(
        'id, api_key_id, request_id, method, path, status_code, ' +
          'response_time_ms, ip, user_agent, error_code, created_at',
      )
      .eq('api_key_id', id)
      .order('created_at', { ascending: false })
      .limit(query.limit ?? 200)
    if (query.since) q = q.gte('created_at', query.since)

    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
