// Operations dashboard — overview-card aggregates.
//
// GET /api/admin/ops/overview
// Auth: admin (RPC permission gate).
//
// Single round trip via the ops_overview() RPC. The response shape
// mirrors the RPC's jsonb directly — UI components destructure
// `listings`, `webhooks`, `ingest`, `inquiries`, `alerts`.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('ops_overview')

    if (error) {
      const status = error.code === '42501' ? 403 : 500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    return data
  },
})
