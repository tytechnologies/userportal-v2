// Deals repository â€” system of record for /api/deals/* endpoints.
//
// Operations: create / list / get / updateStage / addParticipant /
// scheduleViewing / updateViewing / setCommissions.
//
// Audit on every mutation; notify deal participants on state changes.
//
// Stage transitions are recorded automatically by the
// deals_record_stage_history trigger (mig 20260507000021); this repo
// only needs to update deals.stage_key and the audit row goes via
// the standard logActivity path.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'
import { dispatchWebhook } from '~~/server/utils/webhooks'

// Local helper â€” fire-and-forget webhook dispatch with the standard
// .catch() pattern (CONTRIBUTING: never `void <promise>`).
function fireWebhook(kind: string, payload: Record<string, unknown>): void {
  dispatchWebhook(kind, payload).catch((err: unknown) => {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        op: `deals.webhook.${kind}`,
      },
      'deal_webhook_dispatch_threw',
    )
  })
}

// Standard pipeline stage allowlist. The DB column is free-form text
// so operators can extend without migration; this constant keeps the
// API + UI layer typed.
export const STANDARD_STAGES = [
  'inquiry_received',
  'contacted',
  'viewing_scheduled',
  'viewing_completed',
  'negotiating',
  'reservation',
  'documentation',
  'financing',
  'closing',
  'closed_won',
  'closed_lost',
] as const

export type DealCreateInput = {
  inquiryId?: string
  listingId: number
  buyerAgentUserId?: string
  buyerContactId?: number
  stageKey?: string
  dealValue?: number
  currency?: string
  title?: string
  notes?: string
  // Initial co-broker / referrer attribution. Each entry becomes a
  // deal_participants row.
  participants?: Array<{
    userId?: string
    contactId?: number
    role:
      | 'buyer_agent'
      | 'seller_agent'
      | 'co_broker'
      | 'referrer'
      | 'buyer'
      | 'seller'
    splitPct?: number
  }>
}

export const dealsRepo = {
  /**
   * Create a new deal. When inquiryId is provided, populates buyer-
   * side fields from the inquiry + sets the listing's owner as the
   * default seller_agent participant.
   */
  async create({ event, input }: { event: H3Event; input: DealCreateInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Resolve the listing for attribution + seller_agent default.
    const { data: listing, error: listingErr } = await (client as any)
      .from('listings')
      .select('id, title, created_by')
      .eq('id', input.listingId)
      .maybeSingle()
    if (listingErr) {
      throw createError({ statusCode: 500, statusMessage: listingErr.message })
    }
    if (!listing) {
      throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    }

    // Walk listing_copies once to set attribution_source_listing_id
    // when the listing is itself a copy.
    let attributionSource: number | null = null
    {
      const { data: copy } = await (client as any)
        .from('listing_copies')
        .select('source_listing_id')
        .eq('copy_listing_id', input.listingId)
        .maybeSingle()
      if (copy?.source_listing_id) attributionSource = copy.source_listing_id
    }

    // Buyer side defaults to the inquiry's assigned agent (caller, in
    // most cases) â€” explicit override via input.buyerAgentUserId.
    let buyerAgent: string | null = input.buyerAgentUserId ?? user.id
    let buyerContact: number | null = input.buyerContactId ?? null

    if (input.inquiryId) {
      const { data: inq } = await (client as any)
        .from('inquiries')
        .select('id, listing_id, assigned_user_id, sender_name, sender_email, sender_phone')
        .eq('id', input.inquiryId)
        .maybeSingle()
      if (inq) {
        if (!input.buyerAgentUserId && inq.assigned_user_id) {
          buyerAgent = inq.assigned_user_id
        }
        // Don't auto-create a contact from inquiry sender info â€” that
        // belongs to the contacts UI flow. We just record the inquiry
        // FK; the contact link can be added later via update.
      }
    }

    const { data: deal, error: dealErr } = await (client as any)
      .from('deals')
      .insert({
        inquiry_id: input.inquiryId ?? null,
        listing_id: input.listingId,
        attribution_source_listing_id: attributionSource,
        buyer_agent_user_id: buyerAgent,
        buyer_contact_id: buyerContact,
        stage_key: input.stageKey || 'inquiry_received',
        deal_value: input.dealValue ?? null,
        currency: input.currency || 'PHP',
        title: input.title?.trim() || (listing.title ? `Deal: ${listing.title}` : null),
        notes: input.notes?.trim() || null,
        created_by: user.id,
      })
      .select('*')
      .single()

    if (dealErr) {
      logger.error(
        { err: dealErr.message, op: 'deals.create' },
        'deals_create_failed',
      )
      throw createError({ statusCode: 500, statusMessage: dealErr.message })
    }

    // Always-present participants: the buyer agent (caller / assignee)
    // and the listing's owner as seller agent (when distinct from
    // buyer agent â€” same user as both is common for sole-agent deals).
    const seedParticipants: any[] = []
    if (buyerAgent) {
      seedParticipants.push({
        deal_id: deal.id,
        user_id: buyerAgent,
        role: 'buyer_agent',
      })
    }
    if (listing.created_by && listing.created_by !== buyerAgent) {
      seedParticipants.push({
        deal_id: deal.id,
        user_id: listing.created_by,
        role: 'seller_agent',
      })
    }
    // Operator-supplied participants land too. Filter dupes (same
    // user Ã— role pair) â€” DB UNIQUE constraint would 23505 anyway.
    const seenPairs = new Set(seedParticipants.map((p) => `${p.user_id}:${p.role}`))
    for (const p of input.participants || []) {
      const key = `${p.userId}:${p.role}`
      if (p.userId && seenPairs.has(key)) continue
      seedParticipants.push({
        deal_id: deal.id,
        user_id: p.userId ?? null,
        contact_id: p.contactId ?? null,
        role: p.role,
        split_pct: p.splitPct ?? null,
      })
      if (p.userId) seenPairs.add(key)
    }

    if (seedParticipants.length > 0) {
      const { error: partErr } = await (client as any)
        .from('deal_participants')
        .insert(seedParticipants)
      if (partErr) {
        logger.warn(
          { err: partErr.message, deal_id: deal.id, op: 'deals.create.participants' },
          'deals_seed_participants_failed',
        )
        // Don't roll back the deal â€” partial failure here is
        // recoverable via the participants endpoint.
      }
    }

    await logActivity({
      event,
      client,
      action: 'deal.created',
      entity: 'deal',
      entityId: deal.id,
      metadata: {
        deal_id: deal.id,
        listing_id: input.listingId,
        inquiry_id: input.inquiryId ?? null,
        stage_key: deal.stage_key,
        attribution_source_listing_id: attributionSource,
      },
    })

    fireWebhook('deal.created', {
      deal_id: deal.id,
      listing_id: input.listingId,
      inquiry_id: input.inquiryId ?? null,
      buyer_agent_user_id: buyerAgent,
      stage_key: deal.stage_key,
      title: deal.title,
      attribution_source_listing_id: attributionSource,
      created_at: deal.created_at,
    })

    // Notify newly-added participants other than the creator. Fire-
    // and-forget; the deal write succeeds regardless.
    for (const p of seedParticipants) {
      if (!p.user_id || p.user_id === user.id) continue
      notify({
        recipientUserId: p.user_id,
        actorUserId: user.id,
        kind: 'deal.assigned',
        title: `You've been added to a deal`,
        body: deal.title || `Deal on listing #${input.listingId}`,
        href: `/deals/${deal.id}`,
        listingId: input.listingId,
        metadata: { deal_id: deal.id, role: p.role },
      }).catch((err: unknown) => {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            op: 'deals.create.notify',
            deal_id: deal.id,
          },
          'deal_notify_threw',
        )
      })
    }

    return deal
  },

  async list({
    event,
    page,
    pageSize,
    stageKey,
    mine,
    contactId,
  }: {
    event: H3Event
    page: number
    pageSize: number
    stageKey?: string
    mine?: boolean
    /** Filter to deals where this contact is the buyer. Powers the
     *  "Deals on this client" section on /contacts/[id]. RLS still
     *  scopes to deals the caller can see. */
    contactId?: number
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    let q: any = (client as any)
      .from('deals')
      .select(`
        *,
        listing:listings!deals_listing_id_fkey (id, title, sale_price, rent_price, for_sale, for_rent),
        buyer_agent:profiles!deals_buyer_agent_user_id_fkey (id, full_name, avatar_url, slug),
        buyer_contact:contacts!deals_buyer_contact_id_fkey (id, full_name, email, mobile_phone)
      `, { count: 'exact' })
      .order('updated_at', { ascending: false })

    if (stageKey) q = q.eq('stage_key', stageKey)
    if (mine && user?.id) q = q.eq('buyer_agent_user_id', user.id)
    if (contactId) q = q.eq('buyer_contact_id', contactId)

    const from = (page - 1) * pageSize
    q = q.range(from, from + pageSize - 1)

    const { data, count, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return {
      data: data ?? [],
      total: count ?? 0,
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
    }
  },

  async getById({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('deals')
      .select(`
        *,
        listing:listings!deals_listing_id_fkey (id, title, sale_price, rent_price, for_sale, for_rent),
        buyer_agent:profiles!deals_buyer_agent_user_id_fkey (id, full_name, avatar_url, slug),
        buyer_contact:contacts!deals_buyer_contact_id_fkey (id, full_name, email, mobile_phone),
        participants:deal_participants (
          id, role, split_pct, notes, created_at,
          user:profiles!deal_participants_user_id_fkey (id, full_name, avatar_url, slug)
        ),
        viewings:deal_viewings (
          id, scheduled_at, duration_minutes, status, notes, buyer_interest,
          attending:profiles!deal_viewings_attending_user_id_fkey (id, full_name)
        ),
        stage_history:deal_stage_history (
          id, from_stage, to_stage, entered_at, notes
        )
      `)
      .eq('id', id)
      .maybeSingle()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Deal not found or not visible' })
    }
    return data
  },

  async updateStage({
    event,
    id,
    newStage,
    note,
  }: {
    event: H3Event
    id: string
    newStage: string
    note?: string
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const closeUpdates: Record<string, unknown> = {}
    if (newStage === 'closed_won') {
      closeUpdates.closed_at = new Date().toISOString()
      closeUpdates.closed_won = true
    } else if (newStage === 'closed_lost') {
      closeUpdates.closed_at = new Date().toISOString()
      closeUpdates.closed_won = false
    } else {
      // Reopening a closed deal
      closeUpdates.closed_at = null
      closeUpdates.closed_won = null
    }

    const { data, error } = await (client as any)
      .from('deals')
      .update({ stage_key: newStage, ...closeUpdates })
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Deal not found or not editable' })
    }

    const auditAction =
      newStage === 'closed_won' ? 'deal.closed_won' :
      newStage === 'closed_lost' ? 'deal.closed_lost' :
      data.closed_at === null && (data.closed_won === null) ? 'deal.reopened' :
      'deal.stage_changed'

    await logActivity({
      event,
      client,
      action: auditAction,
      entity: 'deal',
      entityId: data.id,
      metadata: {
        deal_id: data.id,
        listing_id: data.listing_id,
        new_stage: newStage,
        note: note?.slice(0, 500) ?? null,
      },
    })

    // Webhook fan-out. Generic stage_changed event for every
    // transition; specific terminal-state events for closed_won /
    // closed_lost so partners that only care about wins can subscribe
    // narrowly.
    fireWebhook('deal.stage_changed', {
      deal_id: data.id,
      listing_id: data.listing_id,
      new_stage: newStage,
      closed_won: data.closed_won,
      closed_at: data.closed_at,
    })
    if (newStage === 'closed_won') {
      fireWebhook('deal.closed_won', {
        deal_id: data.id,
        listing_id: data.listing_id,
        deal_value: data.deal_value,
        currency: data.currency,
        closed_at: data.closed_at,
      })
    } else if (newStage === 'closed_lost') {
      fireWebhook('deal.closed_lost', {
        deal_id: data.id,
        listing_id: data.listing_id,
        closed_at: data.closed_at,
      })
    }

    // Notify participants of stage change. Excludes the actor.
    const { data: participants } = await (client as any)
      .from('deal_participants')
      .select('user_id, role')
      .eq('deal_id', id)
      .not('user_id', 'is', null)
    for (const p of (participants ?? []) as any[]) {
      if (!p.user_id || p.user_id === user?.id) continue
      notify({
        recipientUserId: p.user_id,
        actorUserId: user?.id ?? null,
        kind: 'deal.stage_changed',
        title: 'Deal stage updated',
        body: `${data.title || 'Deal'} moved to ${newStage}`,
        href: `/deals/${id}`,
        listingId: data.listing_id,
        metadata: { deal_id: id, new_stage: newStage },
      }).catch(() => undefined)
    }

    return data
  },

  /**
   * Set / change / clear the buyer contact ("client") on a deal.
   *
   * Pass contactId = null to clear. Contact existence + RLS-visibility
   * is the caller's responsibility â€” the dedicated endpoint
   * (PATCH /api/deals/:id/buyer-contact) does that check.
   *
   * Re-reads the deal via getById so the response is the same shape
   * the detail page consumes â€” no follow-up GET needed on the client.
   */
  async setBuyerContact({
    event,
    id,
    contactId,
  }: {
    event: H3Event
    id: string
    contactId: number | null
  }) {
    const client = await serverSupabaseClient(event)

    // Snapshot the prior contact id for the audit metadata.
    const { data: before } = await (client as any)
      .from('deals')
      .select('id, buyer_contact_id')
      .eq('id', id)
      .maybeSingle()

    const { data, error } = await (client as any)
      .from('deals')
      .update({ buyer_contact_id: contactId })
      .eq('id', id)
      .select('id, buyer_contact_id')
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Deal not found or not editable' })
    }

    await logActivity({
      event,
      client,
      action:
        contactId === null
          ? 'deal.buyer_contact_cleared'
          : before?.buyer_contact_id == null
            ? 'deal.buyer_contact_set'
            : 'deal.buyer_contact_changed',
      entity: 'deal',
      entityId: id,
      metadata: {
        deal_id: id,
        prior_contact_id: before?.buyer_contact_id ?? null,
        new_contact_id: contactId,
      },
    })

    fireWebhook('deal.buyer_contact_changed', {
      deal_id: id,
      prior_contact_id: before?.buyer_contact_id ?? null,
      new_contact_id: contactId,
    })

    // Return the full hydrated deal so the page can refresh inline
    // without a follow-up GET.
    return await dealsRepo.getById({ event, id })
  },

  async addParticipant({
    event,
    dealId,
    userId,
    contactId,
    role,
    splitPct,
  }: {
    event: H3Event
    dealId: string
    userId?: string
    contactId?: number
    role: string
    splitPct?: number
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('deal_participants')
      .insert({
        deal_id: dealId,
        user_id: userId ?? null,
        contact_id: contactId ?? null,
        role,
        split_pct: splitPct ?? null,
      })
      .select('*')
      .single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    await logActivity({
      event,
      client,
      action: 'deal.participant_added',
      entity: 'deal',
      entityId: dealId,
      metadata: { participant_id: data.id, role, user_id: userId ?? null },
    })

    return data
  },

  async scheduleViewing({
    event,
    dealId,
    scheduledAt,
    durationMinutes,
    attendingUserId,
    notes,
  }: {
    event: H3Event
    dealId: string
    scheduledAt: string
    durationMinutes?: number
    attendingUserId?: string
    notes?: string
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const { data, error } = await (client as any)
      .from('deal_viewings')
      .insert({
        deal_id: dealId,
        scheduled_at: scheduledAt,
        duration_minutes: durationMinutes ?? 60,
        attending_user_id: attendingUserId ?? user?.id ?? null,
        notes: notes?.trim() || null,
        status: 'scheduled',
        created_by: user?.id ?? null,
      })
      .select('*')
      .single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    await logActivity({
      event,
      client,
      action: 'viewing.scheduled',
      entity: 'viewing',
      entityId: data.id,
      metadata: {
        deal_id: dealId,
        scheduled_at: scheduledAt,
        attending_user_id: attendingUserId ?? user?.id ?? null,
      },
    })

    fireWebhook('viewing.scheduled', {
      viewing_id: data.id,
      deal_id: dealId,
      scheduled_at: scheduledAt,
      duration_minutes: durationMinutes ?? 60,
      attending_user_id: attendingUserId ?? user?.id ?? null,
    })

    if (attendingUserId && attendingUserId !== user?.id) {
      notify({
        recipientUserId: attendingUserId,
        actorUserId: user?.id ?? null,
        kind: 'viewing.scheduled',
        title: 'Viewing scheduled for you',
        body: `${new Date(scheduledAt).toLocaleString()} â€” ${notes?.slice(0, 80) || 'no note'}`,
        href: `/deals/${dealId}`,
        metadata: { deal_id: dealId, viewing_id: data.id },
      }).catch(() => undefined)
    }

    return data
  },
}
