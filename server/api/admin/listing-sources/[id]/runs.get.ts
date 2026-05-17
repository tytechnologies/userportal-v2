// Recent ingest runs for a single source.
//
// GET /api/admin/listing-sources/:id/runs?limit=10
//
// Admin-only (RLS gates listing_source_ingest_runs.SELECT to
// sources.manage). Returns most-recent first.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const idParam = getRouterParam(event, 'id')
    const sourceId = Number(idParam)
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid source id' })
    }

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('listing_source_ingest_runs')
      .select(
        'id, processed, inserted, updated, errors_count, errors, triggered_by, duration_ms, created_at',
      )
      .eq('source_id', sourceId)
      .order('created_at', { ascending: false })
      .limit(q.limit)

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { data: data ?? [] }
  },
})
