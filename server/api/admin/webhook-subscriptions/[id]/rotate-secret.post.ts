// Rotate a webhook subscription's signing_secret.
//
// POST /api/admin/webhook-subscriptions/:id/rotate-secret
// Auth: admin (webhooks.manage permission gates the underlying RPC).
//
// Wraps the SECURITY DEFINER RPC `rotate_webhook_signing_secret`
// (migration 20260507000009). The RPC regenerates the secret using
// `gen_random_bytes(32)` (matches the column DEFAULT), resets the
// failure counter, and audits the rotation. The new secret is in the
// response body — captured ONCE by the admin UI; never re-fetched.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    // Hard no-store: a stale cached response leaking the new secret
    // would be a security regression even on a private intermediary.
    setHeader(event, 'Cache-Control', 'no-store')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc(
      'rotate_webhook_signing_secret',
      { p_subscription_id: id },
    )

    if (error) {
      const status =
        error.code === '42501' ? 403 :
        error.code === 'P0002' ? 404 :
        500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    return data
  },
})
