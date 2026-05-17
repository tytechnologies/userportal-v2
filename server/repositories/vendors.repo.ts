// Vendors repository â€” service-provider catalog.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

// tax_id plaintext was dropped in migration 076. Use
// public.vendor_get_tax_id(id) via a dedicated endpoint when the
// decrypted value is needed.
const VENDOR_SELECT =
  'id, name, kind, contact_id, email, phone, service_areas, ' +
  'rating, rate_card, documents, status, notes, ' +
  'tax_id_encrypted, tax_id_key_version, ' +
  'withholding_rate_bps, withholding_atc_code, ' +
  'final_withholding_rate_bps, final_withholding_atc_code, ' +
  'created_by, created_at, updated_at'

export type VendorCreateInput = {
  name: string
  kind: string
  contact_id?: number | null
  email?: string | null
  phone?: string | null
  service_areas?: Record<string, unknown>
  rate_card?: Record<string, unknown>
  documents?: Array<Record<string, unknown>>
  status?: 'active' | 'paused' | 'suspended' | 'archived'
  notes?: string | null
  withholding_rate_bps?: number | null
  withholding_atc_code?: string | null
  final_withholding_rate_bps?: number | null
  final_withholding_atc_code?: string | null
}

export type VendorPatchInput = Partial<VendorCreateInput> & {
  rating?: number | null
}

export const vendorsRepo = {
  async list({
    event,
    kind,
    status,
  }: {
    event: H3Event
    kind?: string
    status?: 'active' | 'paused' | 'suspended' | 'archived'
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('vendors')
      .select(VENDOR_SELECT)
      .order('name', { ascending: true })
    if (kind) q = q.eq('kind', kind)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async get({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('vendors')
      .select(VENDOR_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Vendor not found' })
    }
    return data
  },

  async create({ event, input }: { event: H3Event; input: VendorCreateInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const { data, error } = await (client as any)
      .from('vendors')
      .insert({
        name: input.name.trim(),
        kind: input.kind,
        contact_id: input.contact_id ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        // tax_id plaintext column was dropped in migration 076. Encrypted
        // value is set via a separate endpoint (see comment at top of file).
        service_areas: input.service_areas ?? {},
        rate_card: input.rate_card ?? {},
        documents: input.documents ?? [],
        status: input.status ?? 'active',
        notes: input.notes ?? null,
        created_by: user.id,
      })
      .select(VENDOR_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'vendor.created',
      entity: 'building',
      entityId: null,
      metadata: { vendor_id: data.id, kind: data.kind },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'vendors_create_activity_log_failed',
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
    input: VendorPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'name', 'kind', 'contact_id', 'email', 'phone', 'tax_id',
      'service_areas', 'rate_card', 'documents', 'status', 'notes', 'rating',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('vendors')
      .update(updates)
      .eq('id', id)
      .select(VENDOR_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Vendor not found' })
    }
    return data
  },
}
