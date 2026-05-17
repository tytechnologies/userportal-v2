// Operations dashboard — per-table storage + growth.
//
// GET /api/admin/ops/db-growth
// Auth: admin.
//
// Wraps public.ops_db_growth() — one row per table with the latest
// snapshot's sizes + 24h / 7d byte deltas. Sorted by total_bytes DESC
// at the SQL layer; the UI does its own re-sort if the operator clicks
// a different column.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('ops_db_growth')

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { tables: data ?? [] }
  },
})
