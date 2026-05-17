// Leases repository â€” contract record + parties + lifecycle RPCs.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type LeaseStatus =
  | 'draft'
  | 'pending_signature'
  | 'active'
  | 'expired'
  | 'terminated'
  | 'cancelled'

export type LeaseCreateInput = {
  unit_id: string
  listing_id?: number | null
  deal_id?: string | null
  source_document_draft_id?: string | null
  signed_envelope_id?: string | null
  lease_type?: 'residential' | 'commercial' | 'short_term' | 'long_term'
  currency?: string
  rent_minor: number
  rent_period?: 'monthly' | 'quarterly' | 'annual'
  security_deposit_minor?: number
  advance_rent_minor?: number
  effective_at: string
  expires_at: string
  move_in_date?: string | null
  move_out_date?: string | null
  billing_day?: number | null
  escalation_kind?: 'none' | 'fixed_amount' | 'percent' | 'cpi_index'
  escalation_value?: number
  escalation_period_months?: number | null
  utilities_included?: string[]
  house_rules?: string | null
  notes?: string | null
}

export type LeasePatchInput = Partial<Omit<LeaseCreateInput, 'unit_id'>> & {
  status?: 'draft' | 'pending_signature' | 'cancelled'
}

export type LeasePartyInput = {
  role: 'landlord' | 'tenant' | 'guarantor' | 'co_signer' | 'agent'
  user_id?: string | null
  contact_id?: number | null
  external_name?: string | null
  external_email?: string | null
  share_pct?: number | null
  is_primary?: boolean
  notes?: string | null
}

const LEASE_SELECT =
  'id, unit_id, listing_id, deal_id, source_document_draft_id, signed_envelope_id, ' +
  'parent_lease_id, lease_type, currency, rent_minor, rent_period, ' +
  'security_deposit_minor, advance_rent_minor, effective_at, expires_at, ' +
  'move_in_date, move_out_date, billing_day, escalation_kind, escalation_value, ' +
  'escalation_period_months, utilities_included, house_rules, status, ' +
  'activated_at, terminated_at, terminated_by, termination_reason, ' +
  'early_termination_fee_minor, metadata, notes, created_by, created_at, updated_at'

const PARTY_SELECT =
  'id, lease_id, role, user_id, contact_id, external_name, external_email, ' +
  'share_pct, is_primary, notes, created_at'

export const leasesRepo = {
  async list({
    event,
    unitId,
    status,
  }: {
    event: H3Event
    unitId?: string
    status?: LeaseStatus
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('leases')
      .select(LEASE_SELECT)
      .order('effective_at', { ascending: false })
    if (unitId) q = q.eq('unit_id', unitId)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async get({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data: lease, error } = await (client as any)
      .from('leases')
      .select(LEASE_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!lease) {
      throw createError({ statusCode: 404, statusMessage: 'Lease not found' })
    }
    const { data: parties } = await (client as any)
      .from('lease_parties')
      .select(PARTY_SELECT)
      .eq('lease_id', id)
      .order('role', { ascending: true })
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })
    return { lease, parties: parties ?? [] }
  },

  async create({ event, input }: { event: H3Event; input: LeaseCreateInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('leases')
      .insert({
        unit_id: input.unit_id,
        listing_id: input.listing_id ?? null,
        deal_id: input.deal_id ?? null,
        source_document_draft_id: input.source_document_draft_id ?? null,
        signed_envelope_id: input.signed_envelope_id ?? null,
        lease_type: input.lease_type ?? 'residential',
        currency: input.currency ?? 'PHP',
        rent_minor: input.rent_minor,
        rent_period: input.rent_period ?? 'monthly',
        security_deposit_minor: input.security_deposit_minor ?? 0,
        advance_rent_minor: input.advance_rent_minor ?? 0,
        effective_at: input.effective_at,
        expires_at: input.expires_at,
        move_in_date: input.move_in_date ?? null,
        move_out_date: input.move_out_date ?? null,
        billing_day: input.billing_day ?? null,
        escalation_kind: input.escalation_kind ?? 'none',
        escalation_value: input.escalation_value ?? 0,
        escalation_period_months: input.escalation_period_months ?? null,
        utilities_included: input.utilities_included ?? [],
        house_rules: input.house_rules ?? null,
        notes: input.notes ?? null,
        created_by: user.id,
      })
      .select(LEASE_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'leases.create' },
        'leases_create_failed',
      )
      if ((error as any).code === '23514') {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'lease.created',
      entity: 'building',
      entityId: null,
      metadata: { lease_id: data.id, unit_id: data.unit_id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'leases_create_activity_log_failed',
      )
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
    input: LeasePatchInput
  }) {
    const client = await serverSupabaseClient(event)

    // Only draft leases are freely editable. Status transitions to
    // active / expired / terminated go through dedicated RPCs.
    const { data: existing } = await (client as any)
      .from('leases')
      .select('status')
      .eq('id', id)
      .maybeSingle()
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Lease not found' })
    }
    if (existing.status !== 'draft' && existing.status !== 'pending_signature') {
      throw createError({
        statusCode: 409,
        statusMessage: `Lease in status '${existing.status}' is not editable. Use terminate / renew / activate as appropriate.`,
      })
    }

    const updates: Record<string, unknown> = {}
    for (const k of [
      'listing_id', 'deal_id', 'source_document_draft_id', 'signed_envelope_id',
      'lease_type', 'currency', 'rent_minor', 'rent_period',
      'security_deposit_minor', 'advance_rent_minor',
      'effective_at', 'expires_at', 'move_in_date', 'move_out_date',
      'billing_day', 'escalation_kind', 'escalation_value', 'escalation_period_months',
      'utilities_included', 'house_rules', 'notes', 'status',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }

    const { data, error } = await (client as any)
      .from('leases')
      .update(updates)
      .eq('id', id)
      .select(LEASE_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async addParty({
    event,
    leaseId,
    input,
  }: {
    event: H3Event
    leaseId: string
    input: LeasePartyInput
  }) {
    const client = await serverSupabaseClient(event)
    if (!input.user_id && !input.contact_id && !input.external_email && !input.external_name) {
      throw createError({
        statusCode: 400,
        statusMessage: 'At least one identity field is required',
      })
    }
    const { data, error } = await (client as any)
      .from('lease_parties')
      .insert({
        lease_id: leaseId,
        role: input.role,
        user_id: input.user_id ?? null,
        contact_id: input.contact_id ?? null,
        external_name: input.external_name ?? null,
        external_email: input.external_email ?? null,
        share_pct: input.share_pct ?? null,
        is_primary: input.is_primary ?? false,
        notes: input.notes ?? null,
      })
      .select(PARTY_SELECT)
      .single()
    if (error) {
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `Another primary ${input.role} already exists on this lease`,
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async removeParty({
    event,
    leaseId,
    partyId,
  }: {
    event: H3Event
    leaseId: string
    partyId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { error } = await (client as any)
      .from('lease_parties')
      .delete()
      .eq('id', partyId)
      .eq('lease_id', leaseId)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { ok: true }
  },

  async activate({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('lease_activate', {
      p_lease_id: id,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Lease not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'lease.activated',
      entity: 'building',
      entityId: null,
      metadata: { lease_id: id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'leases_activate_activity_log_failed',
      )
    })

    return { lease_id: data ?? id }
  },

  async terminate({
    event,
    id,
    reason,
    terminatedAt,
    earlyFeeMinor,
  }: {
    event: H3Event
    id: string
    reason: string
    terminatedAt?: string
    earlyFeeMinor?: number | null
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('lease_terminate', {
      p_lease_id: id,
      p_reason: reason,
      p_terminated_at: terminatedAt ?? new Date().toISOString(),
      p_early_fee_minor: earlyFeeMinor ?? null,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Lease not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'lease.terminated',
      entity: 'building',
      entityId: null,
      metadata: { lease_id: id, reason },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'leases_terminate_activity_log_failed',
      )
    })

    return { lease_id: data ?? id }
  },

  async renew({
    event,
    parentId,
    newEffectiveAt,
    newExpiresAt,
    newRentMinor,
    newSecurityDepositMinor,
  }: {
    event: H3Event
    parentId: string
    newEffectiveAt: string
    newExpiresAt: string
    newRentMinor: number
    newSecurityDepositMinor?: number | null
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('lease_renew', {
      p_parent_lease_id: parentId,
      p_new_effective_at: newEffectiveAt,
      p_new_expires_at: newExpiresAt,
      p_new_rent_minor: newRentMinor,
      p_new_security_deposit_minor: newSecurityDepositMinor ?? null,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Parent lease not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'lease.renewed',
      entity: 'building',
      entityId: null,
      metadata: { parent_lease_id: parentId, new_lease_id: data },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'leases_renew_activity_log_failed',
      )
    })

    return { new_lease_id: data }
  },

  async listForUnit({
    event,
    unitId,
  }: {
    event: H3Event
    unitId: string
  }) {
    return await this.list({ event, unitId })
  },
}
