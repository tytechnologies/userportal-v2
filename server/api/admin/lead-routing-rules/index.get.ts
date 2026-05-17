// List lead-routing rules.
//
// GET /api/admin/lead-routing-rules?enabled=&limit=

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  enabled: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()
    let q: any = (admin as any)
      .from('lead_routing_rules')
      .select('*')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(query.limit)

    if (query.enabled === 'true') q = q.eq('enabled', true)
    else if (query.enabled === 'false') q = q.eq('enabled', false)

    const { data, error } = await q
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return { items: data ?? [] }
  },
})
