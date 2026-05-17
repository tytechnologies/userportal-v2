// Replay one historical webhook delivery to its subscription.
//
// POST /api/admin/webhook-subscriptions/:id/replay
// Body — exactly one mode:
//   { delivery_id: uuid }   — replay this exact attempt's payload
//   { chain_id: uuid }      — replay the most-recent attempt of this chain
//
// Auth: admin.
//
// What it does:
//   1. Look up the source delivery (by id OR by chain's most-recent
//      row).
//   2. Verify it belongs to the subscription URL parameter — defense
//      against a replay request crossing subscriptions.
//   3. Fire dispatchToSubscription(kind, payload) — runs through the
//      same attempt → record → retry-enqueue pipeline as a fresh
//      send.
//   4. Audit the replay action.
//
// Why a NEW chain id (not extending the original):
//   The historical chain is immutable history. If a replay grew new
//   attempts on the original chain, "Attempt #4" on a chain whose
//   "Attempt #1" was 2 weeks ago would mislead anyone reading the
//   panel. The replay creates its own chain — operators can correlate
//   via the audit metadata which carries the source delivery_id +
//   source chain_id.
//
// Idempotency: replays are intentionally NOT idempotent. A partner
// asking "we missed event X, please re-send" wants exactly one
// re-fire. The operator decides when to invoke; the endpoint doesn't
// dedupe or remember which chains have been replayed.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logActivity } from '~~/server/utils/audit'
import { dispatchToSubscription } from '~~/server/utils/webhooks'

const bodySchema = z
  .object({
    delivery_id: z.string().uuid().optional(),
    chain_id: z.string().uuid().optional(),
  })
  .refine(
    (b) => Boolean(b.delivery_id) !== Boolean(b.chain_id),
    { message: 'Provide exactly one of delivery_id OR chain_id' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const subscriptionId = getRouterParam(event, 'id')
    if (!subscriptionId || !/^[0-9a-f-]{36}$/i.test(subscriptionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid subscription id' })
    }

    const supabase = await serverSupabaseClient(event)
    const admin = getServerSupabaseAdmin()

    // Resolve the source row. Service-role read so the lookup isn't
    // hidden by an admin's session policies — the requireRole gate
    // above is the auth boundary.
    let sourceQuery = (admin as any)
      .from('webhook_deliveries')
      .select(
        'id, subscription_id, event_kind, payload, delivery_chain_id, attempted_at',
      )
      .eq('subscription_id', subscriptionId)
      .order('attempted_at', { ascending: false })
      .limit(1)

    if (body.delivery_id) {
      sourceQuery = sourceQuery.eq('id', body.delivery_id)
    } else {
      sourceQuery = sourceQuery.eq('delivery_chain_id', body.chain_id)
    }

    const { data: rows, error: lookupErr } = await sourceQuery
    if (lookupErr) {
      throw createError({ statusCode: 500, statusMessage: lookupErr.message })
    }
    const source = (rows ?? [])[0]
    if (!source) {
      throw createError({
        statusCode: 404,
        statusMessage: 'No matching delivery for this subscription',
      })
    }

    const dispatchResult = await dispatchToSubscription(
      admin,
      subscriptionId,
      source.event_kind,
      source.payload,
    )

    if (dispatchResult.outcome === 'sub_unavailable') {
      // Subscription was disabled / deleted between the URL param and
      // the dispatch read.
      throw createError({
        statusCode: 409,
        statusMessage: 'Subscription is not available for delivery (disabled or deleted).',
      })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'webhook.subscribed' as any, // existing audit verb covers lifecycle ops
      entity: 'webhook' as any,
      entityId: subscriptionId,
      metadata: {
        op: 'replayed',
        source_delivery_id: source.id,
        source_chain_id: source.delivery_chain_id,
        source_attempted_at: source.attempted_at,
        new_chain_id: dispatchResult.chainId,
        outcome: dispatchResult.outcome,
        event_kind: source.event_kind,
      },
    })

    return {
      replayed: true,
      source_delivery_id: source.id,
      source_chain_id: source.delivery_chain_id,
      new_chain_id: dispatchResult.chainId,
      outcome: dispatchResult.outcome,
      event_kind: source.event_kind,
    }
  },
})
