// Admin — attach a listing as a variant of this property.
//
// POST /api/admin/properties/:id/attach-variant
// Body: {
//   listing_id:        number,   // the listing being reparented
//   set_primary_to?:   number,   // optional — pin properties.primary_listing_id
//   pair_id?:          string,   // optional UUID — listing_duplicate_candidates row to close
// }
//
// Distinct from /api/admin/duplicates/:id/merge (mig 20260507000042):
//   merge          → soft-delete the loser, point its duplicate_of_id at canonical.
//                    Use when the two rows are literally the same listing twice.
//   attach-variant → reparent listing.property_id to this property. Both rows stay live;
//                    use when the rows are distinct listings (for_sale vs for_rent,
//                    two agents marketing the same unit) that should share canonicals.
//
// Wraps merge_listings_into_property RPC. The RPC enforces target/property
// existence and primary-listing ownership.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { refreshListingDetails } from '~~/server/utils/refresh-listing-details'
import { logger } from '~~/server/utils/logger'

const UUID_RE = /^[0-9a-f-]{36}$/i

const bodySchema = z.object({
  listing_id:      z.coerce.number().int().positive(),
  set_primary_to:  z.coerce.number().int().positive().optional().nullable(),
  pair_id:         z.string().regex(UUID_RE).optional().nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const propertyId = Number(getRouterParam(event, 'id') || '0')
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid property id' })
    }

    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any).rpc('merge_listings_into_property', {
      p_source_listing_id:  b.listing_id,
      p_target_property_id: propertyId,
      p_set_primary_to:     b.set_primary_to ?? null,
      p_pair_id:            b.pair_id ?? null,
    })

    if (error) {
      const msg = error.message || 'attach failed'
      if (error.code === '42501') throw createError({ statusCode: 403, statusMessage: msg })
      if (error.code === '42704') throw createError({ statusCode: 404, statusMessage: msg })
      if (error.code === '23514' || error.code === '22023') {
        throw createError({ statusCode: 422, statusMessage: msg })
      }
      throw createError({ statusCode: 500, statusMessage: msg })
    }

    refreshListingDetails(supabase as any, 'admin.properties.attach_variant').catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), op: 'admin.properties.attach_variant' },
        'refresh_after_attach_failed',
      )
    })

    return { ok: true, property_id: propertyId, result: data }
  },
})
