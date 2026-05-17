// Units repository â€” physical asset CRUD.
//
// unit_number is normalised before insert: trimmed, uppercased, with
// any leading 'UNIT '/'#' stripped. Two listings referring to the
// same Unit 12B should land on the same units row regardless of how
// the operator typed it.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type UnitCreateInput = {
  building_id: number
  unit_number: string
  floor?: number | null
  tower?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  floor_area_sqm?: number | null
  balcony_area_sqm?: number | null
  parking_slots?: number | null
  storage_units?: number | null
  orientation?: 'N' | 'E' | 'S' | 'W' | 'NE' | 'NW' | 'SE' | 'SW' | null
  facing?: string | null
  unit_type?: string | null
  features?: Record<string, unknown>
  notes?: string | null
}

export type UnitPatchInput = Partial<Omit<UnitCreateInput, 'building_id' | 'unit_number'>> & {
  status?: 'active' | 'inactive' | 'demolished'
}

const UNIT_SELECT =
  'id, building_id, unit_number, floor, tower, bedrooms, bathrooms, ' +
  'floor_area_sqm, balcony_area_sqm, parking_slots, storage_units, ' +
  'orientation, facing, unit_type, status, features, notes, ' +
  'created_by, created_at, updated_at'

/** Normalise raw operator input to a canonical unit_number. */
export function normaliseUnitNumber(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/^(UNIT\s+|#\s*|UNIT-)/, '')
    .replace(/\s+/g, ' ')
}

export const unitsRepo = {
  async listForBuilding({
    event,
    buildingId,
    status,
  }: {
    event: H3Event
    buildingId: number
    status?: 'active' | 'inactive' | 'demolished'
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('units')
      .select(UNIT_SELECT)
      .eq('building_id', buildingId)
      .order('floor', { ascending: true, nullsFirst: false })
      .order('unit_number', { ascending: true })
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      logger.error(
        { err: error.message, op: 'units.listForBuilding', buildingId },
        'units_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async get({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('units')
      .select(UNIT_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Unit not found' })
    }
    return data
  },

  async create({ event, input }: { event: H3Event; input: UnitCreateInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('units')
      .insert({
        building_id: input.building_id,
        unit_number: normaliseUnitNumber(input.unit_number),
        floor: input.floor ?? null,
        tower: input.tower ?? null,
        bedrooms: input.bedrooms ?? null,
        bathrooms: input.bathrooms ?? null,
        floor_area_sqm: input.floor_area_sqm ?? null,
        balcony_area_sqm: input.balcony_area_sqm ?? null,
        parking_slots: input.parking_slots ?? null,
        storage_units: input.storage_units ?? null,
        orientation: input.orientation ?? null,
        facing: input.facing ?? null,
        unit_type: input.unit_type ?? null,
        features: input.features ?? {},
        notes: input.notes ?? null,
        created_by: user.id,
      })
      .select(UNIT_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'units.create' },
        'units_create_failed',
      )
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `Unit number '${input.unit_number}' already exists in this building`,
        })
      }
      if ((error as any).code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'unit.created',
      entity: 'building',
      entityId: null,
      metadata: { unit_id: data.id, building_id: data.building_id, unit_number: data.unit_number },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'units_create_activity_log_failed',
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
    input: UnitPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'floor', 'tower', 'bedrooms', 'bathrooms', 'floor_area_sqm',
      'balcony_area_sqm', 'parking_slots', 'storage_units',
      'orientation', 'facing', 'unit_type', 'features', 'notes', 'status',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('units')
      .update(updates)
      .eq('id', id)
      .select(UNIT_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Unit not found' })
    }
    return data
  },

  async softDelete({ event, id }: { event: H3Event; id: string }) {
    return await this.patch({ event, id, input: { status: 'inactive' } })
  },

  async listingHistory({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('unit_listing_history')
      .select('*')
      .eq('unit_id', id)
      .order('created_at', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
}
