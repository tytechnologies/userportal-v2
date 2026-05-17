// Create a deal.
//
// POST /api/deals
// Auth: required.
//
// Body:
//   listing_id (required), inquiry_id?, buyer_agent_user_id?,
//   buyer_contact_id?, stage_key?, deal_value?, currency?,
//   title?, notes?,
//   participants?: [{ user_id?, contact_id?, role, split_pct? }],
//   contact?:
//     | { mode: 'create',   full_name, email?, mobile_phone?, notes? }
//     | { mode: 'existing', contact_id: number }
//     | { mode: 'skip' }
//
// When `contact` is supplied, it takes precedence over buyer_contact_id
// (it's the higher-level wizard input vs. the raw foreign key). The
// `create` mode promotes the supplied details into a new CRM contact
// owned by the caller before linking it as the deal's buyer. This
// mirrors the path on /api/inquiries/:id/convert-to-deal so the
// "walked-in buyer" flow on listing detail and the inquiry-conversion
// flow share one server-side surface.
//
// The repository auto-populates the listing's owner as
// seller_agent and the caller (or inquiry assignee) as buyer_agent.
// Operator-supplied participants merge with those defaults; UNIQUE
// constraint dedupes.

import { z } from 'zod'
import { dealsRepo, STANDARD_STAGES } from '~~/server/repositories/deals.repo'
import { contactsRepo } from '~~/server/repositories/contacts.repo'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'

const participantSchema = z.object({
  user_id: z.string().uuid().optional(),
  contact_id: z.number().int().positive().optional(),
  role: z.enum(['buyer_agent', 'seller_agent', 'co_broker', 'referrer', 'buyer', 'seller']),
  split_pct: z.number().int().min(0).max(10000).optional(),
}).refine((p) => p.user_id || p.contact_id, {
  message: 'Either user_id or contact_id is required',
})

// Same shape as on /api/inquiries/:id/convert-to-deal â€” kept inline
// rather than imported so the two endpoints can evolve independently
// if their bodies diverge.
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
  listing_id: z.number().int().positive(),
  inquiry_id: z.string().uuid().optional(),
  buyer_agent_user_id: z.string().uuid().optional(),
  buyer_contact_id: z.number().int().positive().optional(),
  stage_key: z.string().min(1).max(64).optional(),
  deal_value: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  title: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(10_000).optional(),
  participants: z.array(participantSchema).max(20).optional(),
  contact: contactSchema.optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    // Hard role gate â€” agent+ for any deal-creating call. Defense-in-
    // depth on top of RLS, mirroring convert-to-deal. Rejects with a
    // clear 403 instead of letting RLS surface as an opaque insert
    // failure later.
    await requireRole(event, 'agent')

    // Resolve `contact` (wizard-shaped) into a buyer_contact_id. Falls
    // back to the raw `buyer_contact_id` when the wizard isn't used.
    let buyerContactId: number | undefined = body.buyer_contact_id

    if (body.contact?.mode === 'create') {
      const user = await serverSupabaseUser(event)
      if (!user?.id) {
        throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
      }
      // ownerUserId is NOT passed — the contacts table DEFAULT
      // (auth.uid() per mig 20260430000002) stamps it from the JWT
      // that serverSupabaseClient carries. Letting the server pass an
      // explicit value was the same pattern that produced the P0
      // contact silent-data-loss; strict schema dropped the field.
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
        throw createError({
          statusCode: 500,
          statusMessage: 'Contact created but no id returned',
        })
      }
      buyerContactId = (created as any).id as number
    } else if (body.contact?.mode === 'existing') {
      // Verify visibility through RLS â€” surface as 404 if the caller
      // can't see the contact (avoids id-enumeration leakage).
      const supabase = await serverSupabaseClient(event)
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
    // mode === 'skip' OR contact omitted: keep whatever buyer_contact_id
    // the caller passed (typically undefined â†’ buyer link left null).

    const data = await dealsRepo.create({
      event,
      input: {
        listingId: body.listing_id,
        inquiryId: body.inquiry_id,
        buyerAgentUserId: body.buyer_agent_user_id,
        buyerContactId,
        stageKey: body.stage_key,
        dealValue: body.deal_value,
        currency: body.currency,
        title: body.title,
        notes: body.notes,
        participants: body.participants?.map((p) => ({
          userId: p.user_id,
          contactId: p.contact_id,
          role: p.role,
          splitPct: p.split_pct,
        })),
      },
    })

    setResponseStatus(event, 201)
    return {
      ...data,
      contact_mode: body.contact?.mode ?? null,
      buyer_contact_id: buyerContactId ?? null,
    }
  },
})
