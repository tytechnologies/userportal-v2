// List syndication targets.
//
// GET /api/admin/listing-syndication/targets

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status: z.enum(['active', 'paused', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'manager')
    const admin = getServerSupabaseAdmin()
    let q: any = (admin as any)
      .from('listing_syndication_targets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(query.limit)
    if (query.status) q = q.eq('status', query.status)
    const { data, error } = await q
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { items: data ?? [] }
  },
})
