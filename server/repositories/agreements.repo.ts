// Agreements repository â€” referral + co-broker contracts.
//
// Acceptance is two-sided. Anyone holding 'agreements.propose' can
// create a row (status='proposed'); only a party (or admin) can flip
// it to 'active' via accept(). Cancellation is also two-sided in
// principle; today the repo lets either party cancel without the
// other's signature â€” that's a deliberate looseness for the v1.
//
// DELETE on the underlying tables is RLS-blocked. Use cancel().

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type AgreementTermsKind =
  | 'percent_of_commission'
  | 'percent_of_deal_value'
  | 'fixed'

export type AgreementStatus =
  | 'proposed'
  | 'active'
  | 'fulfilled'
  | 'cancelled'
  | 'expired'

export type ReferralScopeType = 'deal' | 'listing' | 'organization' | 'open'

export type ReferralAgreementCreateInput = {
  referrer_user_id?: string | null
  referrer_contact_id?: number | null
  referrer_organization_id?: string | null
  recipient_user_id?: string | null
  recipient_organization_id?: string | null
  scope_type: ReferralScopeType
  scope_listing_id?: number | null
  scope_deal_id?: string | null
  scope_organization_id?: string | null
  terms_kind: AgreementTermsKind
  terms_value: number
  terms_currency?: string
  terms_notes?: string | null
  effective_at?: string
  expires_at?: string | null
  governance_evidence?: Record<string, unknown>
}

export type ReferralAgreementPatchInput = {
  terms_kind?: AgreementTermsKind
  terms_value?: number
  terms_currency?: string
  terms_notes?: string | null
  effective_at?: string
  expires_at?: string | null
  governance_evidence?: Record<string, unknown>
  status?: 'cancelled' | 'expired' | 'fulfilled'
  cancel_reason?: string | null
}

export type CoBrokerAgreementCreateInput = {
  listing_id: number
  listing_agent_user_id?: string | null
  listing_agent_organization_id?: string | null
  co_broker_user_id?: string | null
  co_broker_organization_id?: string | null
  side: 'sell_side' | 'buy_side' | 'both'
  terms_kind: AgreementTermsKind
  terms_value: number
  terms_currency?: string
  terms_notes?: string | null
  exclusivity?: 'exclusive' | 'non_exclusive'
  effective_at?: string
  expires_at?: string | null
  governance_evidence?: Record<string, unknown>
}

export type CoBrokerAgreementPatchInput = {
  terms_kind?: AgreementTermsKind
  terms_value?: number
  terms_currency?: string
  terms_notes?: string | null
  exclusivity?: 'exclusive' | 'non_exclusive'
  effective_at?: string
  expires_at?: string | null
  governance_evidence?: Record<string, unknown>
  status?: 'cancelled' | 'expired' | 'fulfilled'
  cancel_reason?: string | null
}

const REFERRAL_SELECT =
  'id, referrer_user_id, referrer_contact_id, referrer_organization_id, ' +
  'recipient_user_id, recipient_organization_id, scope_type, scope_listing_id, ' +
  'scope_deal_id, scope_organization_id, terms_kind, terms_value, terms_currency, ' +
  'terms_notes, status, effective_at, expires_at, proposed_by, accepted_by, ' +
  'accepted_at, governance_evidence, cancelled_at, cancel_reason, created_at, updated_at'

const CO_BROKER_SELECT =
  'id, listing_id, listing_agent_user_id, listing_agent_organization_id, ' +
  'co_broker_user_id, co_broker_organization_id, side, terms_kind, terms_value, ' +
  'terms_currency, terms_notes, exclusivity, status, effective_at, expires_at, ' +
  'proposed_by, accepted_by, accepted_at, governance_evidence, cancelled_at, ' +
  'cancel_reason, created_at, updated_at'

export const agreementsRepo = {
  // ===== referral =====

  async listReferral({
    event,
    status,
  }: {
    event: H3Event
    status?: AgreementStatus
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('referral_agreements')
      .select(REFERRAL_SELECT)
      .order('created_at', { ascending: false })
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      logger.error(
        { err: error.message, op: 'agreements.listReferral' },
        'agreements_list_referral_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async getReferral({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('referral_agreements')
      .select(REFERRAL_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Agreement not found' })
    }
    return data
  },

  async createReferral({
    event,
    input,
  }: {
    event: H3Event
    input: ReferralAgreementCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    if (
      !input.referrer_user_id &&
      !input.referrer_contact_id &&
      !input.referrer_organization_id
    ) {
      throw createError({
        statusCode: 400,
        statusMessage: 'At least one referrer identifier is required',
      })
    }
    if (!input.recipient_user_id && !input.recipient_organization_id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'At least one recipient identifier is required',
      })
    }
    if (input.scope_type === 'listing' && !input.scope_listing_id) {
      throw createError({ statusCode: 400, statusMessage: 'scope_listing_id required for listing scope' })
    }
    if (input.scope_type === 'deal' && !input.scope_deal_id) {
      throw createError({ statusCode: 400, statusMessage: 'scope_deal_id required for deal scope' })
    }
    if (input.scope_type === 'organization' && !input.scope_organization_id) {
      throw createError({ statusCode: 400, statusMessage: 'scope_organization_id required for organization scope' })
    }

    const insert = {
      referrer_user_id: input.referrer_user_id ?? null,
      referrer_contact_id: input.referrer_contact_id ?? null,
      referrer_organization_id: input.referrer_organization_id ?? null,
      recipient_user_id: input.recipient_user_id ?? null,
      recipient_organization_id: input.recipient_organization_id ?? null,
      scope_type: input.scope_type,
      scope_listing_id: input.scope_listing_id ?? null,
      scope_deal_id: input.scope_deal_id ?? null,
      scope_organization_id: input.scope_organization_id ?? null,
      terms_kind: input.terms_kind,
      terms_value: input.terms_value,
      terms_currency: input.terms_currency ?? 'PHP',
      terms_notes: input.terms_notes ?? null,
      effective_at: input.effective_at ?? new Date().toISOString(),
      expires_at: input.expires_at ?? null,
      governance_evidence: input.governance_evidence ?? {},
      proposed_by: user.id,
    }

    const { data, error } = await (client as any)
      .from('referral_agreements')
      .insert(insert)
      .select(REFERRAL_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'agreements.createReferral' },
        'agreements_create_referral_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'agreement.referral_proposed',
      entity: 'deal',
      entityId: input.scope_deal_id ?? null,
      metadata: {
        agreement_id: data.id,
        scope_type: data.scope_type,
        terms_kind: data.terms_kind,
        terms_value: data.terms_value,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agreements_create_referral_activity_log_failed',
      )
    })

    return data
  },

  async patchReferral({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: ReferralAgreementPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    if (input.terms_kind !== undefined) updates.terms_kind = input.terms_kind
    if (input.terms_value !== undefined) updates.terms_value = input.terms_value
    if (input.terms_currency !== undefined) updates.terms_currency = input.terms_currency
    if (input.terms_notes !== undefined) updates.terms_notes = input.terms_notes
    if (input.effective_at !== undefined) updates.effective_at = input.effective_at
    if (input.expires_at !== undefined) updates.expires_at = input.expires_at
    if (input.governance_evidence !== undefined) {
      updates.governance_evidence = input.governance_evidence
    }
    if (input.status !== undefined) {
      updates.status = input.status
      if (input.status === 'cancelled') {
        updates.cancelled_at = new Date().toISOString()
        updates.cancel_reason = input.cancel_reason ?? null
      }
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }

    const { data, error } = await (client as any)
      .from('referral_agreements')
      .update(updates)
      .eq('id', id)
      .select(REFERRAL_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Agreement not found' })
    }

    logActivity({
      event,
      action:
        input.status === 'cancelled'
          ? 'agreement.referral_cancelled'
          : 'agreement.referral_updated',
      entity: 'deal',
      entityId: data.scope_deal_id ?? null,
      metadata: { agreement_id: id, changed: Object.keys(updates) },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agreements_patch_referral_activity_log_failed',
      )
    })

    return data
  },

  async acceptReferral({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Look up the agreement to verify the caller is the recipient.
    const existing = await this.getReferral({ event, id })
    if (existing.status !== 'proposed') {
      throw createError({
        statusCode: 409,
        statusMessage: `Cannot accept agreement in status '${existing.status}'`,
      })
    }
    const isRecipient = existing.recipient_user_id === user.id
    let isOrgRecipient = false
    if (!isRecipient && existing.recipient_organization_id) {
      const { data: m } = await (client as any)
        .from('organization_memberships')
        .select('id')
        .eq('organization_id', existing.recipient_organization_id)
        .eq('user_id', user.id)
        .maybeSingle()
      isOrgRecipient = !!m
    }
    if (!isRecipient && !isOrgRecipient) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Only the recipient (or a member of the recipient org) can accept',
      })
    }

    const { data, error } = await (client as any)
      .from('referral_agreements')
      .update({
        status: 'active',
        accepted_by: user.id,
        accepted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(REFERRAL_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'agreement.referral_accepted',
      entity: 'deal',
      entityId: data.scope_deal_id ?? null,
      metadata: { agreement_id: id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agreements_accept_referral_activity_log_failed',
      )
    })

    return data
  },

  // ===== co-broker =====

  async listCoBroker({
    event,
    listingId,
    status,
  }: {
    event: H3Event
    listingId?: number
    status?: AgreementStatus
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('co_broker_agreements')
      .select(CO_BROKER_SELECT)
      .order('created_at', { ascending: false })
    if (listingId) q = q.eq('listing_id', listingId)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async getCoBroker({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('co_broker_agreements')
      .select(CO_BROKER_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Agreement not found' })
    }
    return data
  },

  async createCoBroker({
    event,
    input,
  }: {
    event: H3Event
    input: CoBrokerAgreementCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    if (!input.co_broker_user_id && !input.co_broker_organization_id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'At least one co_broker identifier is required',
      })
    }

    const insert = {
      listing_id: input.listing_id,
      listing_agent_user_id: input.listing_agent_user_id ?? null,
      listing_agent_organization_id: input.listing_agent_organization_id ?? null,
      co_broker_user_id: input.co_broker_user_id ?? null,
      co_broker_organization_id: input.co_broker_organization_id ?? null,
      side: input.side,
      terms_kind: input.terms_kind,
      terms_value: input.terms_value,
      terms_currency: input.terms_currency ?? 'PHP',
      terms_notes: input.terms_notes ?? null,
      exclusivity: input.exclusivity ?? 'non_exclusive',
      effective_at: input.effective_at ?? new Date().toISOString(),
      expires_at: input.expires_at ?? null,
      governance_evidence: input.governance_evidence ?? {},
      proposed_by: user.id,
    }

    const { data, error } = await (client as any)
      .from('co_broker_agreements')
      .insert(insert)
      .select(CO_BROKER_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'agreements.createCoBroker' },
        'agreements_create_co_broker_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'agreement.co_broker_proposed',
      entity: 'listing',
      entityId: null,
      metadata: {
        agreement_id: data.id,
        listing_id: data.listing_id,
        side: data.side,
        terms_kind: data.terms_kind,
        terms_value: data.terms_value,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agreements_create_co_broker_activity_log_failed',
      )
    })

    return data
  },

  async patchCoBroker({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: CoBrokerAgreementPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    if (input.terms_kind !== undefined) updates.terms_kind = input.terms_kind
    if (input.terms_value !== undefined) updates.terms_value = input.terms_value
    if (input.terms_currency !== undefined) updates.terms_currency = input.terms_currency
    if (input.terms_notes !== undefined) updates.terms_notes = input.terms_notes
    if (input.exclusivity !== undefined) updates.exclusivity = input.exclusivity
    if (input.effective_at !== undefined) updates.effective_at = input.effective_at
    if (input.expires_at !== undefined) updates.expires_at = input.expires_at
    if (input.governance_evidence !== undefined) {
      updates.governance_evidence = input.governance_evidence
    }
    if (input.status !== undefined) {
      updates.status = input.status
      if (input.status === 'cancelled') {
        updates.cancelled_at = new Date().toISOString()
        updates.cancel_reason = input.cancel_reason ?? null
      }
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }

    const { data, error } = await (client as any)
      .from('co_broker_agreements')
      .update(updates)
      .eq('id', id)
      .select(CO_BROKER_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Agreement not found' })
    }

    logActivity({
      event,
      action:
        input.status === 'cancelled'
          ? 'agreement.co_broker_cancelled'
          : 'agreement.co_broker_updated',
      entity: 'listing',
      entityId: null,
      metadata: { agreement_id: id, changed: Object.keys(updates) },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agreements_patch_co_broker_activity_log_failed',
      )
    })

    return data
  },

  async acceptCoBroker({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const existing = await this.getCoBroker({ event, id })
    if (existing.status !== 'proposed') {
      throw createError({
        statusCode: 409,
        statusMessage: `Cannot accept agreement in status '${existing.status}'`,
      })
    }
    const isRecipient = existing.co_broker_user_id === user.id
    let isOrgRecipient = false
    if (!isRecipient && existing.co_broker_organization_id) {
      const { data: m } = await (client as any)
        .from('organization_memberships')
        .select('id')
        .eq('organization_id', existing.co_broker_organization_id)
        .eq('user_id', user.id)
        .maybeSingle()
      isOrgRecipient = !!m
    }
    if (!isRecipient && !isOrgRecipient) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Only the co_broker (or a member of the co_broker org) can accept',
      })
    }

    const { data, error } = await (client as any)
      .from('co_broker_agreements')
      .update({
        status: 'active',
        accepted_by: user.id,
        accepted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(CO_BROKER_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'agreement.co_broker_accepted',
      entity: 'listing',
      entityId: null,
      metadata: { agreement_id: id, listing_id: data.listing_id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agreements_accept_co_broker_activity_log_failed',
      )
    })

    return data
  },
}
