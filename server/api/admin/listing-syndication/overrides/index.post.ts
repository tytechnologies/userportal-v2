// Create a per-listing override for a syndication target.
//
// POST /api/admin/listing-syndication/overrides
// Body: { target_id, listing_id, override_kind, reason? }
//
// UNIQUE (target_id, listing_id) on the table â€” re-posting for the
// same pair returns 409. Operator deletes the existing override first
// (or PATCHes the kind via DELETE+POST) to swap.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  target_id: z.string().uuid(),
  listing_id: z.number().int().positive(),
  override_kind: z.enum(['force_include', 'force_exclude']),
  reason: z.string().trim().max(500).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()

    // Verify the target exists + listing exists. Cheap upfront so a
    // bad payload returns a clean 404 instead of a generic 23503 FK.
    const { data: target, error: targetErr } = await (admin as any)
      .from('listing_syndication_targets')
      .select('id, slug')
      .eq('id', body.target_id)
      .maybeSingle()
    if (targetErr) {
      throw createError({ statusCode: 500, statusMessage: targetErr.message })
    }
    if (!target) {
      throw createError({ statusCode: 404, statusMessage: 'Target not found' })
    }
    const { data: listing, error: listingErr } = await (admin as any)
      .from('listings')
      .select('id')
      .eq('id', body.listing_id)
      .maybeSingle()
    if (listingErr) {
      throw createError({ statusCode: 500, statusMessage: listingErr.message })
    }
    if (!listing) {
      throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    }

    const { data: created, error: insertErr } = await (admin as any)
      .from('listing_syndication_overrides')
      .insert({
        target_id: body.target_id,
        listing_id: body.listing_id,
        override_kind: body.override_kind,
        reason: body.reason ?? null,
        created_by: user?.id ?? null,
      })
      .select('id, target_id, listing_id, override_kind, reason, created_at')
      .single()
    if (insertErr) {
      logger.error(
        { err: insertErr.message, op: 'admin.syndication.override.create' },
        'syndication_override_create_failed',
      )
      const code = (insertErr as any).code as string | undefined
      if (code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `Override already exists for this (target, listing). Delete it first to change override_kind.`,
        })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not create override' })
    }

    await logActivity({
      event,
      action: 'syndication.override_created',
      entity: 'syndication_target' as any,
      entityId: body.target_id,
      metadata: {
        override_id: created.id,
        listing_id: body.listing_id,
        override_kind: body.override_kind,
      },
    })

    return { override: created }
  },
})
