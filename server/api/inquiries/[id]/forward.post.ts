// Forward an inquiry to a co-broker.
//
// POST /api/inquiries/:id/forward
// Body: { to_user_id: uuid, message?: string }
// Auth: required.
//
// Authorization:
//   - Caller must currently be the inquiry's assigned_user_id
//     (you can only forward what's assigned to you).
//   - Recipient must have an ACCEPTED listing_share with the
//     respond_to_inquiries capability OR be the listing's owner.
//     The collaboration network's permission helper does the check.
//
// Side effects:
//   1. UPDATE inquiries.assigned_user_id = to_user_id
//   2. Audit row: inquiry.forwarded with metadata { from, to, listing_id }
//   3. Notify the recipient
//
// Idempotency: re-forwarding the same inquiry to the same recipient
// is a no-op (assigned_user_id unchanged); audit + notify still fire.
// In practice operators should avoid double-forwarding.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'
import { logger } from '~~/server/utils/logger'
import { evaluateSharePermissions } from '~~/server/utils/sharePermissions'

const bodySchema = z.object({
  to_user_id: z.string().uuid(),
  message: z.string().trim().max(2000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const inquiryId = getRouterParam(event, 'id')
    // Accept uuid OR numeric — see app/server/api/inquiries/[id].patch.ts
    // for the schema-drift context.
    if (!inquiryId || !/^([0-9a-f-]{36}|[0-9]+)$/i.test(inquiryId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid inquiry id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // 1. Load the inquiry and confirm caller is the current assignee.
    const { data: inquiry, error: inqErr } = await (supabase as any)
      .from('inquiries')
      .select('id, listing_id, assigned_user_id, sender_name')
      .eq('id', inquiryId)
      .maybeSingle()
    if (inqErr) throw createError({ statusCode: 500, statusMessage: inqErr.message })
    if (!inquiry) throw createError({ statusCode: 404, statusMessage: 'Inquiry not found' })
    if (inquiry.assigned_user_id !== user.id) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Only the current assignee can forward this inquiry',
      })
    }

    // 2. Verify recipient is authorized — listing owner OR share with
    //    respond_to_inquiries capability.
    const { data: listing } = await (supabase as any)
      .from('listings')
      .select('id, title, created_by')
      .eq('id', inquiry.listing_id)
      .maybeSingle()
    if (!listing) {
      throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    }

    let authorized = false
    if (listing.created_by === body.to_user_id) {
      authorized = true
    } else {
      const { data: share } = await (supabase as any)
        .from('listing_shares')
        .select('share_role, permissions, status, expires_at')
        .eq('listing_id', listing.id)
        .eq('shared_with_user_id', body.to_user_id)
        .maybeSingle()
      if (share) {
        const caps = evaluateSharePermissions(share)
        if (caps.respond_to_inquiries) authorized = true
      }
    }
    if (!authorized) {
      throw createError({
        statusCode: 422,
        statusMessage:
          'Recipient lacks respond_to_inquiries capability on this listing. Share the listing with that capability first, or pick a different recipient.',
      })
    }

    // 3. Atomic-ish: UPDATE the inquiry, then audit + notify.
    const { error: updErr } = await (supabase as any)
      .from('inquiries')
      .update({ assigned_user_id: body.to_user_id })
      .eq('id', inquiryId)
    if (updErr) {
      logger.error(
        { err: updErr.message, op: 'inquiry.forward', inquiryId },
        'inquiry_forward_update_failed',
      )
      throw createError({ statusCode: 500, statusMessage: updErr.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'inquiry.forwarded',
      entity: 'inquiry',
      entityId: inquiryId,
      metadata: {
        from_user_id: user.id,
        to_user_id: body.to_user_id,
        listing_id: listing.id,
        listing_title: listing.title,
        has_message: Boolean(body.message?.trim()),
      },
    })

    // 4. Fan out to the recipient. Fire-and-forget.
    notify({
      recipientUserId: body.to_user_id,
      actorUserId: user.id,
      kind: 'inquiry.forwarded',
      title: 'An inquiry was forwarded to you',
      body: listing.title
        ? `${inquiry.sender_name} on "${listing.title}"`
        : `Forwarded inquiry from ${inquiry.sender_name}`,
      href: `/inquiries?id=${inquiryId}`,
      listingId: listing.id,
      metadata: {
        inquiry_id: inquiryId,
        forwarded_by: user.id,
        sender_name: inquiry.sender_name,
        forward_message: body.message?.trim() || null,
      },
    }).catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          op: 'inquiry.forward.notify',
          inquiry_id: inquiryId,
        },
        'inquiry_forward_notify_threw',
      )
    })

    return {
      forwarded: true,
      inquiry_id: inquiryId,
      from_user_id: user.id,
      to_user_id: body.to_user_id,
    }
  },
})
