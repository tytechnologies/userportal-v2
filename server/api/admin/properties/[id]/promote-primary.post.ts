// Admin — pin properties.primary_listing_id to a chosen variant.
//
// POST /api/admin/properties/:id/promote-primary
// Body: { listing_id: number }
//
// Validates that listing_id is a live (non-soft-deleted) variant of
// the given property, then sets properties.primary_listing_id.
// Pass `null` to clear the pin and let elect_primary_listing_id()
// pick at read time again.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { refreshListingDetails } from '~~/server/utils/refresh-listing-details'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  listing_id: z.coerce.number().int().positive().nullable(),
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

    if (b.listing_id !== null) {
      const { data: variant, error: lookupErr } = await (supabase as any)
        .from('listings')
        .select('id, property_id, deleted_at')
        .eq('id', b.listing_id)
        .maybeSingle()

      if (lookupErr) throw createError({ statusCode: 500, statusMessage: lookupErr.message })
      if (!variant) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
      if (variant.property_id !== propertyId) {
        throw createError({
          statusCode: 422,
          statusMessage: `Listing ${variant.id} is not a variant of property ${propertyId}`,
        })
      }
      if (variant.deleted_at) {
        throw createError({
          statusCode: 422,
          statusMessage: 'Cannot pin a soft-deleted listing as primary',
        })
      }
    }

    const { error: updErr } = await (supabase as any)
      .from('properties')
      .update({
        primary_listing_id: b.listing_id,
        updated_at:         new Date().toISOString(),
      })
      .eq('id', propertyId)

    if (updErr) throw createError({ statusCode: 500, statusMessage: updErr.message })

    refreshListingDetails(supabase as any, 'admin.properties.promote_primary').catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), op: 'admin.properties.promote_primary' },
        'refresh_after_promote_failed',
      )
    })

    return { ok: true, property_id: propertyId, primary_listing_id: b.listing_id }
  },
})
