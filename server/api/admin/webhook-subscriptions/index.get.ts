// List webhook subscriptions.
//
// GET /api/admin/webhook-subscriptions
// Auth: admin (webhooks.manage gates RLS).
//
// SECURITY:
// `signing_secret` is INTENTIONALLY EXCLUDED from the column list.
// The secret is returned ONCE at creation (banner-revealed in the
// admin UI) and regenerated via the dedicated /rotate-secret endpoint
// — never sent again on a list response. Reduces the blast radius of
// a misconfigured client / browser-cache leak.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const PUBLIC_COLS =
  'id, source_id, display_name, url, event_kinds, enabled, ' +
  'consecutive_failures, last_delivery_at, last_delivery_status, ' +
  'notes, created_at, updated_at'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('webhook_subscriptions')
      .select(PUBLIC_COLS)
      .order('created_at', { ascending: false })

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { data: data ?? [] }
  },
})
