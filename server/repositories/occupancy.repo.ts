// Occupancy repository â€” append-only occupancy ledger for units.
//
// Records who's living in a unit, with provenance. Most-recent open
// row per unit is exposed via unit_current_occupancy view; the full
// history is queryable via list().
//
// CORRECTION model: instead of UPDATE-mutating an old row, the
// operator stamps move_out_at on the prior open row and inserts a
// new row reflecting the new state. The patch() method below is
// intentionally narrow â€” only move_out_at, notes, lease_id can be
// updated; identity / dates / kind are immutable once recorded.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type OccupancyCreateInput = {
  occupancy_kind:
    | 'owner_occupied'
    | 'tenant_lease'
    | 'vacant'
    | 'developer_held'
    | 'undisclosed'
  occupant_user_id?: string | null
  occupant_contact_id?: number | null
  occupant_external_name?: string | null
  occupant_external_email?: string | null
  lease_id?: string | null
  move_in_at?: string
  source?: string
  notes?: string | null
}

export type OccupancyPatchInput = {
  move_out_at?: string | null
  lease_id?: string | null
  notes?: string | null
}

const OCC_SELECT =
  'id, unit_id, occupancy_kind, occupant_user_id, occupant_contact_id, ' +
  'occupant_external_name, occupant_external_email, lease_id, move_in_at, ' +
  'move_out_at, reported_by, source, notes, created_at, updated_at'

export const occupancyRepo = {
  async listForUnit({
    event,
    unitId,
  }: {
    event: H3Event
    unitId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('unit_occupancy')
      .select(OCC_SELECT)
      .eq('unit_id', unitId)
      .order('move_in_at', { ascending: false })
    if (error) {
      logger.error(
        { err: error.message, op: 'occupancy.listForUnit', unitId },
        'occupancy_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async record({
    event,
    unitId,
    input,
  }: {
    event: H3Event
    unitId: string
    input: OccupancyCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Close any prior open occupancy row first â€” operator-recorded
    // move-in implies the previous occupant has departed.
    const { error: closeErr } = await (client as any)
      .from('unit_occupancy')
      .update({ move_out_at: input.move_in_at ?? new Date().toISOString() })
      .eq('unit_id', unitId)
      .is('move_out_at', null)
    if (closeErr) {
      logger.warn(
        { err: closeErr.message, op: 'occupancy.record.close_prior', unitId },
        'occupancy_close_prior_failed',
      )
      // Non-fatal: even if we can't close the prior row, the new
      // row is still useful audit data.
    }

    const { data, error } = await (client as any)
      .from('unit_occupancy')
      .insert({
        unit_id: unitId,
        occupancy_kind: input.occupancy_kind,
        occupant_user_id: input.occupant_user_id ?? null,
        occupant_contact_id: input.occupant_contact_id ?? null,
        occupant_external_name: input.occupant_external_name ?? null,
        occupant_external_email: input.occupant_external_email ?? null,
        lease_id: input.lease_id ?? null,
        move_in_at: input.move_in_at ?? new Date().toISOString(),
        reported_by: user.id,
        source: input.source ?? 'admin',
        notes: input.notes ?? null,
      })
      .select(OCC_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'occupancy.record', unitId },
        'occupancy_record_failed',
      )
      if ((error as any).code === '23514') {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'unit.occupancy_recorded',
      entity: 'building',
      entityId: null,
      metadata: {
        unit_id: unitId,
        occupancy_id: data.id,
        kind: data.occupancy_kind,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'occupancy_record_activity_log_failed',
      )
    })

    return data
  },

  /**
   * Narrow update â€” only move_out_at, lease_id, notes are mutable.
   * Identity / dates / kind are immutable; corrections insert a new
   * row instead.
   */
  async patch({
    event,
    unitId,
    occupancyId,
    input,
  }: {
    event: H3Event
    unitId: string
    occupancyId: string
    input: OccupancyPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    if (input.move_out_at !== undefined) updates.move_out_at = input.move_out_at
    if (input.lease_id !== undefined) updates.lease_id = input.lease_id
    if (input.notes !== undefined) updates.notes = input.notes
    if (Object.keys(updates).length === 0) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Only move_out_at, lease_id, notes are mutable',
      })
    }

    const { data, error } = await (client as any)
      .from('unit_occupancy')
      .update(updates)
      .eq('id', occupancyId)
      .eq('unit_id', unitId)
      .select(OCC_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'occupancy.patch', occupancyId },
        'occupancy_patch_failed',
      )
      if ((error as any).code === '23514') {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Occupancy row not found' })
    }
    return data
  },
}
