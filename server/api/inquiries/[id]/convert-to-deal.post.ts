// Convert an inquiry into a deal — and optionally promote the
// inquirer into a CRM contact ("client") in the same call.
//
// POST /api/inquiries/:id/convert-to-deal
// Body:
//   {
//     stage_key?, deal_value?, title?, notes?,
//     contact?:
//       | { mode: 'create',   full_name, email?, mobile_phone?, notes? }
//       | { mode: 'existing', contact_id: number }
//       | { mode: 'skip' }
//   }
//
// Backwards-compatible — when `contact` is omitted (or mode='skip')
// the endpoint behaves exactly as before: a deal is created with no
// buyer contact link, and the caller is expected to set one later.
//
// Auth: required. The caller must be able to read the inquiry (RLS
// enforces inquiries.read.assigned / .team / .all) and to write
// contacts.write.own (RLS again — contactsRepo.create stamps the
// owner_user_id from the JWT).
//
// Side effects:
//   1. (optional) Creates a new contact owned by the caller.
//   2. Creates the deal with buyer_contact_id linked to the new/existing contact.
//   3. Flips the inquiry's status to 'in_progress' so the inbox
//      shows it as moved-on.

import { z } from 'zod'
import { dealsRepo } from '~~/server/repositories/deals.repo'
import { contactsRepo } from '~~/server/repositories/contacts.repo'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const contactCreateInput = z.object({
  full_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  mobile_phone: z.string().trim().max(50).optional(),
  notes: z.string().trim().max(2000).optional(),
})

const contactSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create') }).merge(contactCreateInput),
  z.object({ mode: z.literal('existing'), contact_id: z.number().int().positive() }),
  z.object({ mode: z.literal('skip') }),
])

const bodySchema = z.object({
  stage_key: z.string().trim().min(1).max(64).optional(),
  deal_value: z.number().positive().optional(),
  title: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(10_000).optional(),
  contact: contactSchema.optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    // Hard role gate — agent+ (i.e. any operator profile). Defense-in-
    // depth on top of RLS: rejects with a clear 403 "insufficient role"
    // instead of letting RLS surface as an opaque insert/update failure
    // later in the call. Doesn't change behavior for legitimate callers.
    await requireRole(event, 'agent')

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

    // Resolve the inquiry to get listing_id + sender info. Authorization
    // is via RLS — the caller can read inquiries they're assigned to OR
    // team-scope per inquiries.read.team.
    const { data: inquiry, error: inqErr } = await (supabase as any)
      .from('inquiries')
      .select('id, listing_id, assigned_user_id, sender_name, sender_email, sender_phone')
      .eq('id', inquiryId)
      .maybeSingle()
    if (inqErr) throw createError({ statusCode: 500, statusMessage: inqErr.message })
    if (!inquiry) {
      throw createError({ statusCode: 404, statusMessage: 'Inquiry not found' })
    }

    // ----- Resolve buyer contact -----------------------------------------
    // Three modes:
    //   create   — make a new CRM contact owned by the caller
    //   existing — link an already-known contact
    //   skip     — no buyer contact set (legacy / backwards-compat default)
    let buyerContactId: number | undefined
    const contactMode = body.contact?.mode ?? 'skip'

    if (body.contact?.mode === 'create') {
      // The contact picker on the wizard pre-fills these from the
      // inquiry's sender_* fields, but the operator can edit before
      // submitting. We call contactsRepo.create which audits + RLS-
      // guards via owner_user_id = caller. ownerUserId is stamped
      // server-side via DB DEFAULT auth.uid() — same fix as the P0
      // contact silent-data-loss issue.
      const created = await contactsRepo.create({
        event,
        input: {
          name: body.contact.full_name,
          email: body.contact.email ?? null,
          mobilePhone: body.contact.mobile_phone ?? null,
          notes: body.contact.notes ?? null,
        },
      })
      if (!created || typeof (created as any).id !== 'number') {
        // Defensive — contactsRepo.create throws on the error path,
        // but a legitimate row insert with no id back is unrecoverable.
        throw createError({
          statusCode: 500,
          statusMessage: 'Contact created but no id returned',
        })
      }
      buyerContactId = (created as any).id as number
    } else if (body.contact?.mode === 'existing') {
      // Verify the contact exists + is readable (RLS will scope this
      // to contacts.read.own / .team / .all). 404 here means the caller
      // can't see the contact, which is treated the same as missing.
      const { data: existing, error: existErr } = await (supabase as any)
        .from('contacts')
        .select('id')
        .eq('id', body.contact.contact_id)
        .maybeSingle()
      if (existErr) {
        throw createError({ statusCode: 500, statusMessage: existErr.message })
      }
      if (!existing) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Contact not found or not visible to caller',
        })
      }
      buyerContactId = body.contact.contact_id
    }
    // mode === 'skip' OR contact omitted: leave buyerContactId undefined
    // → deal is created with buyer_contact_id = NULL, matching the
    //   pre-2026-05-09 behavior of this endpoint.

    // ----- Create the deal ----------------------------------------------
    const deal = await dealsRepo.create({
      event,
      input: {
        inquiryId,
        listingId: inquiry.listing_id,
        buyerAgentUserId: inquiry.assigned_user_id ?? user.id,
        buyerContactId,
        stageKey: body.stage_key || 'inquiry_received',
        dealValue: body.deal_value,
        title: body.title,
        notes: body.notes,
      },
    })

    // Flip inquiry status to in_progress — the inquiry has graduated.
    // Best-effort; failure here doesn't roll back the deal.
    try {
      await (supabase as any)
        .from('inquiries')
        .update({ status: 'in_progress' })
        .eq('id', inquiryId)
        .eq('status', 'new') // only flip new → in_progress; don't downgrade
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'inquiries.convert_to_deal.status_update' },
        'inquiry_convert_status_update_failed',
      )
    }

    setResponseStatus(event, 201)
    return {
      ...deal,
      // Surface what the wizard chose so the client can navigate
      // accordingly (e.g. show "Created new client X and deal Y").
      contact_mode: contactMode,
      buyer_contact_id: buyerContactId ?? null,
    }
  },
})
