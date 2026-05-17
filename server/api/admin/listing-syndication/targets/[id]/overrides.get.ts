// List per-listing overrides for a syndication target.
//
// GET /api/admin/listing-syndication/targets/[id]/overrides

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  override_kind: z.enum(['force_include', 'force_exclude']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'manager')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid target id' })
    }

    const admin = getServerSupabaseAdmin()
    let q: any = (admin as any)
      .from('listing_syndication_overrides')
      .select('id, target_id, listing_id, override_kind, reason, created_by, created_at')
      .eq('target_id', id)
      .order('created_at', { ascending: false })
      .limit(query.limit)
    if (query.override_kind) q = q.eq('override_kind', query.override_kind)

    const { data, error } = await q
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return { items: data ?? [] }
  },
})
