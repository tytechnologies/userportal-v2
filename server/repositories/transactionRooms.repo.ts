// Transaction-rooms repository. Wraps supabase access with the
// same audit + RLS-trust pattern as deals.repo.ts.
//
// A transaction room is the operational container for a closing:
// participants, documents, files, notes, signatures, audit log.
// It optionally points at a deal_id and/or listing_id; it can also
// stand alone for one-off transactions that didn't go through the
// pipeline.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

// Hydration shape returned to clients. Keeps the foreign-key fan-out
// compact â€” listing/deal/contact each return only what UIs render.
const ROOM_HYDRATED_COLUMNS = `
  *,
  listing:listings!transaction_rooms_listing_id_fkey (
    id, title, sale_price, rent_price, street_address, barangay
  ),
  deal:deals!transaction_rooms_deal_id_fkey (
    id, title, stage_key, deal_value, currency
  ),
  buyer_contact:contacts!transaction_rooms_buyer_contact_id_fkey (
    id, full_name, email, mobile_phone
  ),
  seller_contact:contacts!transaction_rooms_seller_contact_id_fkey (
    id, full_name, email, mobile_phone
  ),
  organization:organizations!transaction_rooms_organization_id_fkey (
    id, name
  ),
  participants:transaction_room_participants (
    id, role, user_id, contact_id,
    user:profiles (id, full_name, avatar_url),
    contact:contacts (id, full_name, email, mobile_phone)
  ),
  documents:transaction_room_documents (
    id, draft_id, added_at,
    draft:document_drafts (id, title, status, doc_type_key, updated_at)
  ),
  files:transaction_room_files (
    id, filename, mime_type, size_bytes, description, uploaded_at
  )
`

export const transactionRoomsRepo = {
  async list({
    event,
    page,
    pageSize,
    status,
    mine,
    listingId,
    contactId,
    dealId,
  }: {
    event: H3Event
    page: number
    pageSize: number
    status?: string
    mine?: boolean
    listingId?: number
    contactId?: number
    dealId?: string
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    let q: any = (client as any)
      .from('transaction_rooms')
      .select(`
        id, name, status, listing_id, buyer_contact_id, seller_contact_id,
        deal_id, organization_id, owner_user_id, closed_at, created_at, updated_at,
        listing:listings!transaction_rooms_listing_id_fkey (id, title),
        buyer_contact:contacts!transaction_rooms_buyer_contact_id_fkey (id, full_name)
      `, { count: 'exact' })
      .order('updated_at', { ascending: false })

    if (status)     q = q.eq('status', status)
    if (mine && user?.id) q = q.eq('owner_user_id', user.id)
    if (listingId)  q = q.eq('listing_id', listingId)
    if (contactId) {
      // Match either buyer or seller contact slot.
      q = q.or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    }
    if (dealId)     q = q.eq('deal_id', dealId)

    const from = (page - 1) * pageSize
    q = q.range(from, from + pageSize - 1)

    const { data, error, count } = await q
    if (error) {
      logger.error({ err: error.message, op: 'transaction_rooms.list' }, 'tr_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return {
      data: data ?? [],
      total: count ?? 0,
      page,
      page_size: pageSize,
      total_pages: count ? Math.ceil(count / pageSize) : 0,
    }
  },

  async getById({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('transaction_rooms')
      .select(ROOM_HYDRATED_COLUMNS)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'transaction_rooms.get' }, 'tr_get_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Transaction room not found' })
    }
    return data
  },

  async create({
    event,
    input,
  }: {
    event: H3Event
    input: {
      name: string
      listingId?: number | null
      buyerContactId?: number | null
      sellerContactId?: number | null
      dealId?: string | null
      organizationId?: string | null
      metadata?: Record<string, unknown> | null
    }
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('transaction_rooms')
      .insert({
        name: input.name,
        owner_user_id: user.id,
        listing_id:        input.listingId        ?? null,
        buyer_contact_id:  input.buyerContactId   ?? null,
        seller_contact_id: input.sellerContactId  ?? null,
        deal_id:           input.dealId           ?? null,
        organization_id:   input.organizationId   ?? null,
        metadata:          input.metadata         ?? {},
      })
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'transaction_rooms.create' }, 'tr_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      client,
      action: 'transaction_room.created' as any,
      entity: 'transaction_room' as any,
      entityId: data.id,
      metadata: {
        room_id: data.id,
        listing_id: input.listingId,
        deal_id: input.dealId,
        buyer_contact_id: input.buyerContactId,
      },
    })

    return data
  },

  async patch({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: {
      name?: string
      status?: string
      listingId?: number | null
      buyerContactId?: number | null
      sellerContactId?: number | null
      dealId?: string | null
      organizationId?: string | null
      metadata?: Record<string, unknown>
    }
  }) {
    const client = await serverSupabaseClient(event)
    const update: Record<string, unknown> = {}
    if (input.name      !== undefined) update.name = input.name
    if (input.status    !== undefined) update.status = input.status
    if (input.listingId !== undefined) update.listing_id = input.listingId
    if (input.buyerContactId  !== undefined) update.buyer_contact_id = input.buyerContactId
    if (input.sellerContactId !== undefined) update.seller_contact_id = input.sellerContactId
    if (input.dealId    !== undefined) update.deal_id = input.dealId
    if (input.organizationId !== undefined) update.organization_id = input.organizationId
    if (input.metadata  !== undefined) update.metadata = input.metadata
    if (input.status === 'closed' || input.status === 'archived') {
      update.closed_at = new Date().toISOString()
    } else if (input.status === 'open' || input.status === 'in_review') {
      update.closed_at = null
    }

    const { data, error } = await (client as any)
      .from('transaction_rooms')
      .update(update)
      .eq('id', id)
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'transaction_rooms.patch' }, 'tr_patch_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      client,
      action: 'transaction_room.updated' as any,
      entity: 'transaction_room' as any,
      entityId: id,
      metadata: { room_id: id, ...update },
    })

    return await this.getById({ event, id })
  },

  async addParticipant({
    event,
    roomId,
    input,
  }: {
    event: H3Event
    roomId: string
    input: {
      userId?: string | null
      contactId?: number | null
      role: string
    }
  }) {
    if (!input.userId && !input.contactId) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Participant requires either user_id or contact_id',
      })
    }
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('transaction_room_participants')
      .insert({
        room_id: roomId,
        user_id:    input.userId    ?? null,
        contact_id: input.contactId ?? null,
        role:       input.role,
      })
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'transaction_rooms.add_participant' }, 'tr_add_part_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async linkDocument({
    event,
    roomId,
    draftId,
  }: {
    event: H3Event
    roomId: string
    draftId: string
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const { data, error } = await (client as any)
      .from('transaction_room_documents')
      .insert({
        room_id:  roomId,
        draft_id: draftId,
        added_by: user?.id ?? null,
      })
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'transaction_rooms.link_doc' }, 'tr_link_doc_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },
}
