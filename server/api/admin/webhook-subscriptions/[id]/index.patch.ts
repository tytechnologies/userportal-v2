// Update a webhook subscription.
//
// PATCH /api/admin/webhook-subscriptions/:id
// Auth: admin.
//
// Use cases: enable/disable, change event_kinds, rename, edit notes,
// update URL after a partner migrates. To rotate the signing_secret,
// use the dedicated /rotate-secret endpoint (out of scope this round —
// admins can rotate via SQL until that ships).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.object({
  display_name: z.string().trim().min(1).max(160).optional(),
  url: z.string().trim().url().max(2048).startsWith('https://').optional(),
  event_kinds: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  enabled: z.boolean().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }

    const update: Record<string, unknown> = {}
    for (const k of ['display_name', 'url', 'event_kinds', 'enabled', 'notes'] as const) {
      if (body[k] !== undefined) update[k] = body[k]
    }
    if (update.enabled === true) {
      // Re-enabling clears the failure counter so the subscription
      // gets a fresh start.
      update.consecutive_failures = 0
    }
    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const supabase = await serverSupabaseClient(event)
    // Same column allowlist as the list endpoint — never echo the
    // signing_secret back on a PATCH. Rotation is the only path that
    // reveals a (new) secret.
    const { data, error } = await (supabase as any)
      .from('webhook_subscriptions')
      .update(update)
      .eq('id', id)
      .select(
        'id, source_id, display_name, url, event_kinds, enabled, ' +
        'consecutive_failures, last_delivery_at, last_delivery_status, ' +
        'notes, created_at, updated_at',
      )
      .maybeSingle()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Subscription not found' })
    return data
  },
})
