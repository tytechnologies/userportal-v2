// Duplicate a listing into the caller's portfolio with attribution.
//
// POST /api/listings/:id/duplicate
// Body (optional):
//   { overrides?: { title?, description?, contact_id? } }
//
// Auth: required. Authorization happens INSIDE the
// duplicate_listing_with_attribution() RPC (migration
// 20260507000015):
//   1. Caller is the source listing's owner   → allowed
//   2. Caller has listings.write.all          → allowed
//   3. Caller has accepted share with         → allowed
//      duplicate_allowed=true OR legacy
//      share_role='co_broker'
// Otherwise 403 (42501 from the RPC).
//
// Side effects (atomic — single RPC):
//   - INSERT new public.listings row owned by the caller
//   - INSERT public.listing_copies row linking source → copy
//   - 2 audit rows (one on source, one on copy)
//
// The copy starts with is_online = false; the copying agent must
// publish explicitly. contact_id is NOT copied (the copying agent
// owns the customer relationship for their copy) — pass via
// overrides.contact_id if needed.
//
// Notification: the source owner is notified (notify() helper) that
// their listing was duplicated by a partner. Fire-and-forget; never
// blocks the response.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { notify } from '~~/server/utils/notifications'
import { enforceRateLimit, clientIp } from '~~/server/utils/rate-limit'

const bodySchema = z.object({
  overrides: z
    .object({
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().trim().max(50_000).optional(),
      contact_id: z.number().int().positive().optional(),
    })
    .optional(),
})

const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW = 3600 // 1 hour

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id) || id <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Rate limit — 10 duplications/hour/user. Stops accidental loops
    // and the obvious "spam the marketplace with copies" abuse.
    try {
      await enforceRateLimit({
        event,
        client,
        key: `listings.duplicate:${user.id}`,
        max: RATE_LIMIT_MAX,
        windowSeconds: RATE_LIMIT_WINDOW,
      })
    } catch (err: any) {
      if (err?.statusCode === 429) throw err
      logger.warn(
        { err: err?.message, op: 'listings.duplicate.rate_limit' },
        'duplicate_rate_limit_init_failed',
      )
    }

    const overrides = body.overrides ?? {}
    const { data, error } = await (client as any).rpc(
      'duplicate_listing_with_attribution',
      {
        p_source_listing_id: id,
        p_overrides: overrides,
      },
    )

    if (error) {
      const status =
        error.code === '42501' ? 403 :
        error.code === 'P0002' ? 404 :
        error.code === '22023' ? 400 :
        500
      logger.error(
        { err: error.message, code: error.code, op: 'listings.duplicate', source_id: id },
        'listings_duplicate_failed',
      )
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    // Notify the source owner. Fire-and-forget with .catch() — see
    // CONTRIBUTING for the void-vs-catch reasoning.
    if (data?.source_owner_user_id && data.source_owner_user_id !== user.id) {
      notify({
        recipientUserId: data.source_owner_user_id,
        actorUserId: user.id,
        kind: 'listing.duplicated_by_partner',
        title: 'Your listing was duplicated by a partner',
        body: `A partner co-broker created their own copy of listing #${id}.`,
        href: `/listings/${id}`,
        listingId: id,
        metadata: {
          source_listing_id: id,
          copy_listing_id: data.copy_listing_id,
        },
      }).catch((err: unknown) => {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            op: 'listings.duplicate.notify',
            copy_listing_id: data.copy_listing_id,
          },
          'duplicate_notify_threw',
        )
      })
    }

    setResponseStatus(event, 201)
    return data
  },
})
