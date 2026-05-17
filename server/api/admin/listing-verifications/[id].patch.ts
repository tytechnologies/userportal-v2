// Approve or reject a listing verification request.
//
// PATCH /api/admin/listing-verifications/:id
// Body: { status: 'approved' | 'rejected', review_notes?: string }
// Auth: admin + verifications.review_listings.
//
// Optimistic-concurrency guard: only flips rows whose current status
// is 'pending' — second admin clicking the same row gets 404 ("row
// disappeared"). Mirrors profile_verifications PATCH semantics.
//
// Audits with verification.listing_approved or verification.listing_rejected
// so the activity feed surfaces the lifecycle event.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  status: z.enum(['approved', 'rejected']),
  review_notes: z.string().trim().max(2000).nullable().optional(),
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

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const { data, error } = await (supabase as any)
      .from('listing_verifications')
      .update({
        status: body.status,
        review_notes: body.review_notes ?? null,
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error(
        { err: error.message, op: 'listing_verifications.review', id },
        'listing_verification_review_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Request not found, not pending, or already reviewed',
      })
    }

    await logActivity({
      event,
      client: supabase,
      action: body.status === 'approved'
        ? 'verification.listing_approved'
        : 'verification.listing_rejected',
      entity: 'verification',
      entityId: data.id,
      metadata: {
        listing_id: data.listing_id,
        reviewer_id: user?.id ?? null,
        has_review_notes: !!data.review_notes,
      },
    })

    return data
  },
})
