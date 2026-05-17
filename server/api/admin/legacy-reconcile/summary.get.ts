// Summary of unreconciled *_legacy columns on listings.
//
// GET /api/admin/legacy-reconcile/summary?limit=25&offset=0
// Auth: admin (legacy.reconcile permission gates the underlying RPC).
//
// Wraps the `legacy_creators_summary(int, int)` RPC. The RPC returns
// counts + paginated suggestions in one round trip, so this endpoint
// is a thin pass-through.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any).rpc(
      'legacy_creators_summary',
      { p_limit: q.limit, p_offset: q.offset },
    )

    if (error) {
      // 42501 from the RPC = permission denied. Map to 403 so the UI
      // can show a clean message instead of a generic 500.
      const status = (error.code === '42501') ? 403 : 500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    return data ?? {
      counts: {},
      suggestions: [],
      total_suggestions: 0,
      has_trgm: false,
    }
  },
})
