// Schema governance — drift report.
//
// GET /api/admin/schema/drift
// Auth: admin (governance.read permission, RPC-gated).
//
// Calls governance_check_all_contracts(), which iterates every
// active contract and validates against information_schema. Returns
// one row per contract with a status + findings array.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    // Fresh on every call. The dashboard's "Run drift check" button is
    // user-triggered; we never want a cached result hiding new drift.
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('governance_check_all_contracts')

    if (error) {
      const status = error.code === '42501' ? 403 : 500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    const rows = Array.isArray(data) ? data : []
    const summary = {
      total: rows.length,
      healthy: rows.filter((r: any) => r.status === 'healthy').length,
      drift:   rows.filter((r: any) => r.status === 'drift').length,
      missing: rows.filter((r: any) => r.status === 'missing').length,
    }

    return {
      summary,
      contracts: rows,
      checked_at: new Date().toISOString(),
    }
  },
})
