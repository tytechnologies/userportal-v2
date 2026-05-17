// Manual inquiry creation â€” for phone-call / WhatsApp / walk-in leads
// the agent receives offline. The public website continues to write
// via /api/public/inquiries (different shape, different auth).
//
// POST /api/inquiries
// Auth: required.
// Body: { listing_id, sender_name, sender_email?, sender_phone?,
//         message, channel? }
//
// Permission gate: caller must be able to write inquiries for the
// target listing's assigned agent â€” the inquiries.write.{assigned,
// team,all} family. We enforce this server-side using the same logic
// the inquiries_update RLS policy uses for UPDATE.
//
// Side effects:
//   1. Insert with `source = channel ?? 'manual'` so this row is
//      distinguishable from website-submitted inquiries in reporting.
//   2. assigned_user_id = listing.created_by (matches the public
//      endpoint's snapshot semantics).
//   3. log_activity('inquiry.created_manually')
//
// Uses service role for the INSERT because the inquiries table has NO
// INSERT policy for `authenticated` (mig 20260502000006 line 161-164
// â€” by design, to funnel writes through validated endpoints). The
// permission gate above is the security boundary.

import { z } from 'zod'
import { serverSupabaseUser } from '../../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'

const bodySchema = z.object({
  listing_id:  z.coerce.number().int().positive(),
  sender_name: z.string().trim().min(1).max(200),
  sender_email: z.string().trim().email().max(320).optional().nullable(),
  sender_phone: z.string().trim().min(3).max(40).optional().nullable(),
  message:     z.string().trim().min(1).max(5000),
  channel:     z.enum(['phone', 'whatsapp', 'walk_in', 'referral', 'manual']).optional(),
}).refine(
  (b) => !!(b.sender_email || b.sender_phone),
  { message: 'Provide at least one of sender_email or sender_phone', path: ['sender_email'] },
)

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const b    = body as z.infer<typeof bodySchema>
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const admin = getServerSupabaseAdmin()

    // Resolve the listing (also confirms it exists). Reads created_by
    // for assignment + listing_title for the audit metadata.
    const { data: listing, error: listingErr } = await (admin as any)
      .from('listings')
      .select('id, created_by, listing_title')
      .eq('id', b.listing_id)
      .maybeSingle()
    if (listingErr) {
      throw createError({ statusCode: 500, statusMessage: listingErr.message })
    }
    if (!listing) {
      throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    }

    // Permission gate. Anyone who could UPDATE this listing's
    // inquiries can also CREATE one for it â€” same scope as the RLS
    // UPDATE policy. We re-derive via has_permission RPCs called
    // through the user's authenticated client (NOT admin).
    const { serverSupabaseClient } = await import('#supabase/server/serverSupabaseClient')
    const userClient = await serverSupabaseClient(event)

    const [{ data: writeAll }, { data: writeTeam }] = await Promise.all([
      (userClient as any).rpc('has_permission', { permission_to_check: 'inquiries.write.all' }),
      (userClient as any).rpc('has_permission', { permission_to_check: 'inquiries.write.team' }),
    ])

    let allowed = writeAll === true
    if (!allowed && writeTeam === true) {
      // Caller has team scope â€” confirm the listing's creator is on
      // their team. Fast lookup against profiles.
      const { data: callerProfile } = await (admin as any)
        .from('profiles')
        .select('team_id')
        .eq('id', user.id)
        .maybeSingle()
      const { data: ownerProfile } = await (admin as any)
        .from('profiles')
        .select('team_id')
        .eq('id', listing.created_by)
        .maybeSingle()
      if (callerProfile?.team_id && callerProfile.team_id === ownerProfile?.team_id) {
        allowed = true
      }
    }
    if (!allowed && listing.created_by === user.id) {
      // Caller IS the listing's owner â€” assigned-scope is implicit.
      allowed = true
    }
    if (!allowed) {
      throw createError({
        statusCode: 403,
        statusMessage: 'You can\'t log inquiries for this listing.',
      })
    }

    // Insert. assigned_user_id mirrors the public endpoint's snapshot
    // semantics â€” points at the listing's owner, not the caller, so
    // the inquiry routes to whoever owns the listing.
    const { data: inserted, error: insErr } = await (admin as any)
      .from('inquiries')
      .insert({
        listing_id:       b.listing_id,
        assigned_user_id: listing.created_by,
        sender_name:      b.sender_name,
        sender_email:     b.sender_email ?? null,
        sender_phone:     b.sender_phone ?? null,
        sender_user_id:   null,
        message:          b.message,
        source:           b.channel ?? 'manual',
        status:           'new',
      })
      .select('*')
      .single()
    if (insErr) {
      throw createError({ statusCode: 500, statusMessage: insErr.message })
    }

    // Audit. Best-effort; doesn't block the response.
    await (admin as any).rpc('log_activity', {
      p_action:    'inquiry.created_manually',
      p_entity:    'inquiry',
      p_entity_id: inserted.id,
      p_metadata:  {
        listing_id:    b.listing_id,
        listing_title: listing.listing_title ?? null,
        channel:       b.channel ?? 'manual',
        logged_by:     user.id,
      },
    }).catch((err: any) =>
      console.warn('[/api/inquiries POST] log_activity failed', err),
    )

    // Notify the assigned agent (best-effort) so they see it land in
    // their dashboard widget.
    if (listing.created_by && listing.created_by !== user.id) {
      await (admin as any).rpc('notify', {
        p_recipient_user_id: listing.created_by,
        p_kind:              'listing.inquiry_received',
        p_title:             listing.listing_title ?? 'Listing inquiry',
        p_body:              `${b.sender_name} â€” manually logged by a teammate.`,
        p_href:              `/inquiries?id=${inserted.id}`,
        p_metadata:          { inquiry_id: inserted.id, manual: true },
      }).catch((err: any) =>
        console.warn('[/api/inquiries POST] notify failed', err),
      )
    }

    return { inquiry: inserted }
  },
})
