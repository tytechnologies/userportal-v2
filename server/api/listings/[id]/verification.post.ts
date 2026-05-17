// Submit a listing verification request.
//
// POST /api/listings/:id/verification
// Body: { evidence_url?: string, applicant_notes?: string }
// Auth: required. RLS on listing_verifications enforces:
//   - submitted_by = auth.uid()
//   - caller owns the listing (created_by = auth.uid())
//
// UNIQUE(listing_id) means re-submitting upserts the existing row.
// Status flips to 'pending' on every fresh submission so an admin
// who rejected an earlier attempt sees the new evidence.
//
// Audits as verification.listing_submitted; no notification yet
// (admins discover via the Verifications tab queue, same as
// profile_verifications).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  evidence_url: z.string().trim().url().max(2048).optional(),
  applicant_notes: z.string().trim().max(2000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id) || id <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Re-submission resets status to 'pending'. The UNIQUE(listing_id)
    // upsert handles both create + update.
    const { data, error } = await (supabase as any)
      .from('listing_verifications')
      .upsert(
        {
          listing_id: id,
          submitted_by: user.id,
          status: 'pending',
          evidence_url: body.evidence_url || null,
          applicant_notes: body.applicant_notes || null,
          submitted_at: new Date().toISOString(),
          // Clear any prior review fields so the queue shows it fresh.
          reviewed_by: null,
          reviewed_at: null,
          review_notes: null,
        },
        { onConflict: 'listing_id' },
      )
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'listing_verifications.submit', listing_id: id },
        'listing_verification_submit_failed',
      )
      // RLS rejection (caller doesn't own the listing) → 403
      const status = error.code === '42501' ? 403 : 500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'verification.listing_submitted',
      entity: 'verification',
      entityId: data.id,
      metadata: {
        listing_id: id,
        has_evidence_url: Boolean(body.evidence_url),
      },
    })

    setResponseStatus(event, 201)
    return data
  },
})
