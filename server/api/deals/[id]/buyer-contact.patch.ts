// Set / change / clear the buyer contact ("client") on a deal.
//
// PATCH /api/deals/:id/buyer-contact
// Body:
//   { contact: { mode: 'create',   full_name, email?, mobile_phone?, notes? } }
//   { contact: { mode: 'existing', contact_id: number } }
//   { contact: { mode: 'clear' } }
//
// Auth: required. RLS gates row visibility on `deals` (must be a
// participant, the buyer/seller agent, or admin/manager via
// deal_can_read). Setting a contact also re-verifies that the caller
// can see the target contact (RLS scope on `contacts`) so we don't
// link a contact the user shouldn't be able to read.
//
// Side effects: deals.buyer_contact_id is updated; logActivity records
// the change with the prior + new contact ids in the metadata.

import { z } from 'zod'
import { dealsRepo } from '~~/server/repositories/deals.repo'
import { contactsRepo } from '~~/server/repositories/contacts.repo'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'

const contactCreateInput = z.object({
  full_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  mobile_phone: z.string().trim().max(50).optional(),
  notes: z.string().trim().max(2000).optional(),
})

const bodySchema = z.object({
  contact: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('create') }).merge(contactCreateInput),
    z.object({ mode: z.literal('existing'), contact_id: z.number().int().positive() }),
    z.object({ mode: z.literal('clear') }),
  ]),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    // Hard role gate — defense-in-depth on top of the deal RLS policy.
    // Same agent+ minimum as convert-to-deal.
    await requireRole(event, 'agent')

    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Resolve contact_id from the request shape.
    let contactId: number | null
    if (body.contact.mode === 'create') {
      // ownerUserId stamped server-side via DB DEFAULT auth.uid(). See
      // server/api/deals/index.post.ts for the rationale (same fix as
      // the P0 contact silent-data-loss).
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
      contactId = (created as any).id as number
    } else if (body.contact.mode === 'existing') {
      // Verify the contact is RLS-visible. 404 if the caller can't read
      // it — same semantics as convert-to-deal's existing branch.
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
      contactId = body.contact.contact_id
    } else {
      // mode === 'clear'
      contactId = null
    }

    const updated = await dealsRepo.setBuyerContact({
      event,
      id: dealId,
      contactId,
    })

    return updated
  },
})
