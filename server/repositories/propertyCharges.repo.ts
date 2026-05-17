// Property charges repository â€” charge ledger + payment hooks.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const SELECT =
  'id, charge_no, kind, unit_id, lease_id, rent_schedule_id, ' +
  'dues_schedule_id, work_order_id, charged_to_user_id, charged_to_contact_id, ' +
  'charged_to_external_name, charged_to_external_email, billing_target, ' +
  'period_start, period_end, currency, subtotal_minor, tax_minor, ' +
  'total_minor, amount_paid_minor, status, issued_at, due_at, paid_at, ' +
  'voided_at, void_reason, payment_intent_id, external_reference, ' +
  'line_items, notes, metadata, created_by, created_at, updated_at'

export type PropertyChargeFilter = {
  unit_id?: string
  lease_id?: string
  status?: 'draft' | 'open' | 'paid' | 'past_due' | 'void' | 'forgiven'
  kind?:
    | 'rent'
    | 'dues'
    | 'maintenance_pass_through'
    | 'damage'
    | 'late_fee'
    | 'security_deposit'
    | 'adjustment'
}

export const propertyChargesRepo = {
  async list({
    event,
    filter,
  }: {
    event: H3Event
    filter: PropertyChargeFilter
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('property_charges')
      .select(SELECT)
      .order('period_start', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (filter.unit_id) q = q.eq('unit_id', filter.unit_id)
    if (filter.lease_id) q = q.eq('lease_id', filter.lease_id)
    if (filter.status) q = q.eq('status', filter.status)
    if (filter.kind) q = q.eq('kind', filter.kind)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async get({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('property_charges')
      .select(SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Charge not found' })
    }
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
      status?: 'open' | 'past_due' | 'void' | 'forgiven'
      void_reason?: string | null
      notes?: string | null
      external_reference?: string | null
      metadata?: Record<string, unknown>
    }
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    if (input.status !== undefined) updates.status = input.status
    if (input.void_reason !== undefined) updates.void_reason = input.void_reason
    if (input.notes !== undefined) updates.notes = input.notes
    if (input.external_reference !== undefined) {
      updates.external_reference = input.external_reference
    }
    if (input.metadata !== undefined) updates.metadata = input.metadata
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('property_charges')
      .update(updates)
      .eq('id', id)
      .select(SELECT)
      .single()
    if (error) {
      const msg = error.message ?? ''
      if (msg.includes('locked once issued') || msg.includes('append-only')) {
        throw createError({ statusCode: 409, statusMessage: msg })
      }
      throw createError({ statusCode: 500, statusMessage: msg })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Charge not found' })
    }
    return data
  },

  async recordPayment({
    event,
    id,
    amountMinor,
    intentId,
  }: {
    event: H3Event
    id: string
    amountMinor: number
    intentId?: string | null
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('record_property_charge_payment', {
      p_charge_id: id,
      p_amount_minor: amountMinor,
      p_intent_id: intentId ?? null,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: 'Charge not found' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'charge.paid',
      entity: 'building',
      entityId: null,
      metadata: { charge_id: id, amount_minor: amountMinor },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'charge_payment_activity_log_failed',
      )
    })

    return { charge_id: data ?? id }
  },
}
