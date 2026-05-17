// Operations dashboard — read alert threshold config.
//
// GET /api/admin/ops/alert-thresholds
// Auth: admin.
//
// Returns every row in public.ops_alert_thresholds. Order by key
// for stable rendering in the form.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('ops_alert_thresholds')
      .select('key, value_int, description, updated_at, updated_by')
      .order('key', { ascending: true })

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { thresholds: data ?? [] }
  },
})
