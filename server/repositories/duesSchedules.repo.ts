// Dues schedules repository â€” HOA / condo / parking / utilities.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const SELECT =
  'id, unit_id, dues_type, billing_target, currency, amount_minor, period, ' +
  'billing_day, next_due_at, last_charged_at, status, auto_generate, ' +
  'effective_at, ended_at, notes, metadata, created_by, created_at, updated_at'

export type DuesScheduleCreateInput = {
  unit_id: string
  dues_type: string
  billing_target?: 'owner' | 'tenant'
  amount_minor: number
  currency?: string
  period?: 'monthly' | 'quarterly' | 'annual'
  billing_day: number
  next_due_at: string
  auto_generate?: boolean
  effective_at?: string
  ended_at?: string | null
  notes?: string | null
  metadata?: Record<string, unknown>
}

export type DuesSchedulePatchInput = Partial<
  Omit<DuesScheduleCreateInput, 'unit_id' | 'next_due_at'>
> & {
  status?: 'active' | 'paused' | 'ended'
  next_due_at?: string
}

export const duesSchedulesRepo = {
  async listForUnit({ event, unitId }: { event: H3Event; unitId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('dues_schedules')
      .select(SELECT)
      .eq('unit_id', unitId)
      .order('effective_at', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async create({
    event,
    unitId,
    input,
  }: {
    event: H3Event
    unitId: string
    input: Omit<DuesScheduleCreateInput, 'unit_id'>
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('dues_schedules')
      .insert({
        unit_id: unitId,
        dues_type: input.dues_type,
        billing_target: input.billing_target ?? 'owner',
        currency: input.currency ?? 'PHP',
        amount_minor: input.amount_minor,
        period: input.period ?? 'monthly',
        billing_day: input.billing_day,
        next_due_at: input.next_due_at,
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
        { err: error.message, op: 'duesSchedules.create' },
        'dues_schedule_create_failed',
      )
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
    input: DuesSchedulePatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'dues_type', 'billing_target', 'amount_minor', 'currency', 'period',
      'billing_day', 'next_due_at', 'status', 'auto_generate',
      'effective_at', 'ended_at', 'notes', 'metadata',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('dues_schedules')
      .update(updates)
      .eq('id', scheduleId)
      .select(SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Dues schedule not found' })
    }
    return data
  },
}
