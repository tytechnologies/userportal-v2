// Rent schedules repository.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const SELECT =
  'id, lease_id, tenant_party_id, currency, amount_minor, period, ' +
  'billing_day, next_due_at, last_charged_at, escalation_kind, ' +
  'escalation_value, escalation_period_months, status, auto_generate, ' +
  'effective_at, ended_at, notes, metadata, created_by, created_at, updated_at'

export type RentScheduleCreateInput = {
  lease_id: string
  tenant_party_id?: string | null
  amount_minor: number
  currency?: string
  period?: 'monthly' | 'quarterly' | 'annual'
  billing_day: number
  next_due_at: string
  escalation_kind?: 'none' | 'fixed_amount' | 'percent' | 'cpi_index'
  escalation_value?: number
  escalation_period_months?: number | null
  auto_generate?: boolean
  effective_at?: string
  ended_at?: string | null
  notes?: string | null
  metadata?: Record<string, unknown>
}

export type RentSchedulePatchInput = Partial<
  Omit<RentScheduleCreateInput, 'lease_id' | 'next_due_at'>
> & {
  status?: 'active' | 'paused' | 'ended'
  next_due_at?: string
}

export const rentSchedulesRepo = {
  async listForLease({ event, leaseId }: { event: H3Event; leaseId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('rent_schedules')
      .select(SELECT)
      .eq('lease_id', leaseId)
      .order('effective_at', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async create({
    event,
    leaseId,
    input,
  }: {
    event: H3Event
    leaseId: string
    input: Omit<RentScheduleCreateInput, 'lease_id'>
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('rent_schedules')
      .insert({
        lease_id: leaseId,
        tenant_party_id: input.tenant_party_id ?? null,
        currency: input.currency ?? 'PHP',
        amount_minor: input.amount_minor,
        period: input.period ?? 'monthly',
        billing_day: input.billing_day,
        next_due_at: input.next_due_at,
        escalation_kind: input.escalation_kind ?? 'none',
        escalation_value: input.escalation_value ?? 0,
        escalation_period_months: input.escalation_period_months ?? null,
        auto_generate: input.auto_generate ?? false,
        effective_at: input.effective_at ?? new Date().toISOString(),
        ended_at: input.ended_at ?? null,
        notes: input.notes ?? null,
        metadata: input.metadata ?? {},
        created_by: user.id,
      })
      .select(SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'rentSchedules.create' },
        'rent_schedule_create_failed',
      )
      if ((error as any).code === '23514') {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async patch({
    event,
    scheduleId,
    input,
  }: {
    event: H3Event
    scheduleId: string
    input: RentSchedulePatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'tenant_party_id', 'amount_minor', 'currency', 'period', 'billing_day',
      'next_due_at', 'escalation_kind', 'escalation_value',
      'escalation_period_months', 'status', 'auto_generate',
      'effective_at', 'ended_at', 'notes', 'metadata',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('rent_schedules')
      .update(updates)
      .eq('id', scheduleId)
      .select(SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Rent schedule not found' })
    }
    return data
  },
}
