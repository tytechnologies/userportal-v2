// Admin — list broker import batches.
//
// GET /api/admin/brokers/import?page=1&page_size=20
// Returns batches in reverse-chronological order with per-outcome
// counts so the UI renders the summary without extra round trips.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)

    const from = (q.page - 1) * q.page_size
    const to = from + q.page_size - 1

    const { data: batches, error, count } = await (supabase as any)
      .from('broker_import_batches')
      .select('id, source_label, uploaded_by, total_rows, processed_rows, status, created_at, processed_at',
              { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    if (!batches || batches.length === 0) {
      return { batches: [], total: count ?? 0, page: q.page, page_size: q.page_size }
    }

    // Per-batch outcome counts. PostgREST can't GROUP BY, so pull all
    // rows for the visible batches in one query and aggregate
    // client-side. For 20 batches × ~hundreds of rows, this is cheap.
    const ids = batches.map((b: any) => b.id)
    const { data: rows } = await (supabase as any)
      .from('broker_import_rows')
      .select('batch_id, outcome')
      .in('batch_id', ids)

    const counts = new Map<string, Record<string, number>>()
    for (const r of rows ?? []) {
      const m = counts.get(r.batch_id) ?? {}
      m[r.outcome] = (m[r.outcome] ?? 0) + 1
      counts.set(r.batch_id, m)
    }

    // Resolve uploader names so the UI can show "by Alice".
    const uploaderIds = Array.from(new Set(
      batches.map((b: any) => b.uploaded_by).filter(Boolean),
    ))
    let uploaderMap = new Map<string, any>()
    if (uploaderIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name')
        .in('id', uploaderIds)
      for (const p of profiles ?? []) uploaderMap.set(p.id, p)
    }

    const enriched = batches.map((b: any) => ({
      ...b,
      uploader: b.uploaded_by ? uploaderMap.get(b.uploaded_by) ?? null : null,
      outcomes: counts.get(b.id) ?? {},
    }))

    return {
      batches:   enriched,
      total:     count ?? 0,
      page:      q.page,
      page_size: q.page_size,
    }
  },
})
