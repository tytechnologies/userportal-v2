// GET /api/admin/api-keys?status=active&kind=live
// Cross-org list. RLS gates to api_keys.manage.platform.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  kind: z.enum(['live', 'test', 'restricted']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('api_keys')
      .select(
        'id, organization_id, name, prefix, last4, kind, scopes, status, ' +
          'last_used_at, expires_at, created_by, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(500)
    if (query.status) q = q.eq('status', query.status)
    if (query.kind) q = q.eq('kind', query.kind)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
