// Admin — list ticker messages (enabled + disabled).
//
// GET /api/admin/ticker
//
// Returns every ticker row regardless of enabled state for the
// /admin/ticker CRUD page. Public-facing read is at
// /api/public/ticker (RLS-gated to enabled=true).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('marketing_ticker_messages')
      .select(
        'id, kind, label, source_config, tone, link_url, priority, enabled, ' +
          'notes, created_by, created_at, updated_at',
      )
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false })

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { items: data ?? [] }
  },
})
