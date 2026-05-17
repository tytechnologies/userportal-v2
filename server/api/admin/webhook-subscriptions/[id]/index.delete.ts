// Delete a webhook subscription.
//
// DELETE /api/admin/webhook-subscriptions/:id
// Auth: admin.
//
// CASCADE: webhook_deliveries.subscription_id has ON DELETE CASCADE
// (migration 20260507000002), so the delivery log for this
// subscription goes with it. If you want to preserve the audit trail
// of past deliveries, disable the subscription instead (PATCH with
// { enabled: false }) — disabled subs stop receiving events but keep
// their history.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }

    const supabase = await serverSupabaseClient(event)

    // Read the row first so we can audit the deletion with meaningful
    // metadata. .maybeSingle() returns null for both "doesn't exist"
    // and "RLS hid it"; we treat both as 404 to avoid leaking which.
    const { data: existing } = await (supabase as any)
      .from('webhook_subscriptions')
      .select('id, display_name, url')
      .eq('id', id)
      .maybeSingle()

    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Subscription not found' })
    }

    const { error } = await (supabase as any)
      .from('webhook_subscriptions')
      .delete()
      .eq('id', id)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    await logActivity({
      event,
      client: supabase,
      action: 'webhook.subscribed' as any, // existing audit verb covers lifecycle changes
      entity: 'webhook' as any,
      entityId: existing.id,
      metadata: {
        op: 'deleted',
        display_name: existing.display_name,
        url_host: (() => {
          try { return new URL(existing.url).hostname } catch { return null }
        })(),
      },
    })

    setResponseStatus(event, 204)
    return null
  },
})
