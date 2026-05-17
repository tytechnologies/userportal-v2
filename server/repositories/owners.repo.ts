// Owners repository â€” property_owners + unit_owners.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const OWNER_SELECT =
  'id, user_id, contact_id, external_name, external_email, tax_id, ' +
  'billing_address, bank_account, notes, created_at, updated_at'

const UNIT_OWNER_SELECT =
  'id, unit_id, owner_id, share_pct, is_primary, effective_at, ended_at, ' +
  'source, notes, created_at'

export type OwnerInput = {
  user_id?: string | null
  contact_id?: number | null
  external_name?: string | null
  external_email?: string | null
  tax_id?: string | null
  billing_address?: Record<string, unknown>
  bank_account?: Record<string, unknown>
  notes?: string | null
}

export type RegisterUnitOwnerInput = {
  owner: OwnerInput
  share_pct?: number | null
  is_primary?: boolean
}

export const ownersRepo = {
  async list({ event }: { event: H3Event }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('property_owners')
      .select(OWNER_SELECT)
      .order('created_at', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async get({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('property_owners')
      .select(OWNER_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Owner not found' })
    }
    return data
  },

  async create({ event, input }: { event: H3Event; input: OwnerInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const { data, error } = await (client as any)
      .from('property_owners')
      .insert({
        user_id: input.user_id ?? null,
        contact_id: input.contact_id ?? null,
        external_name: input.external_name ?? null,
        external_email: input.external_email ?? null,
        tax_id: input.tax_id ?? null,
        billing_address: input.billing_address ?? {},
        bank_account: input.bank_account ?? {},
        notes: input.notes ?? null,
        created_by: user.id,
      })
      .select(OWNER_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'owners.create' },
        'owners_create_failed',
      )
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'An owner with that identity already exists',
        })
      }
      if ((error as any).code === '23514') {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
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
    input: OwnerInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'external_name', 'external_email', 'tax_id',
      'billing_address', 'bank_account', 'notes',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('property_owners')
      .update(updates)
      .eq('id', id)
      .select(OWNER_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Owner not found' })
    }
    return data
  },

  async listForUnit({ event, unitId }: { event: H3Event; unitId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('unit_owners')
      .select(UNIT_OWNER_SELECT)
      .eq('unit_id', unitId)
      .order('ended_at', { ascending: true, nullsFirst: true })
      .order('effective_at', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async registerForUnit({
    event,
    unitId,
    input,
  }: {
    event: H3Event
    unitId: string
    input: RegisterUnitOwnerInput
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('register_unit_owner', {
      p_unit_id: unitId,
      p_owner: input.owner,
      p_share_pct: input.share_pct ?? null,
      p_is_primary: input.is_primary ?? false,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'owners.registerForUnit', unitId },
        'owners_register_failed',
      )
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'unit.owner_registered',
      entity: 'building',
      entityId: null,
      metadata: { unit_id: unitId, owner_id: data?.owner_id, unit_owner_id: data?.unit_owner_id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'owners_register_activity_log_failed',
      )
    })

    return data
  },

  async endOwnership({
    event,
    unitId,
    linkId,
  }: {
    event: H3Event
    unitId: string
    linkId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('unit_owners')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', linkId)
      .eq('unit_id', unitId)
      .is('ended_at', null)
      .select(UNIT_OWNER_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Active ownership link not found',
      })
    }
    return data
  },
}
