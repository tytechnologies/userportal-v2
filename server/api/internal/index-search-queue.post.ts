// Internal — drain search_index_queue into the external search engine.
//
// POST /api/internal/index-search-queue
// Auth: x-internal-secret header matching INTERNAL_CRON_SECRET.
//
// Strategy:
//   1. Claim up to BATCH pending rows in FIFO order. Mark processed
//      AFTER the engine call succeeds so a crash mid-flight retries.
//   2. Coalesce: collapse multiple pending rows for the same
//      property_id to its latest op (upsert wins over a prior delete
//      if both queued for the same id — though that's pathological).
//   3. For each unique property_id, build the SearchDocument from
//      properties + the elected/pinned primary listing + city/barangay
//      denorms, and upsert into Typesense.
//   4. When TYPESENSE_HOST is unset, every operation no-ops gracefully
//      — the queue keeps growing harmlessly until the engine lands.
//      (Backfill on the day of cutover is just "drain the queue".)

import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import {
  isTypesenseEnabled,
  upsertDocument,
  deleteDocument,
  type SearchDocument,
} from '~~/server/utils/typesense'

const BATCH = 200

const bodySchema = z.object({
  max: z.coerce.number().int().min(1).max(2000).optional(),
})

function authorized(provided: string | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided.trim(), 'utf8')
  const b = Buffer.from(expected.trim(), 'utf8')
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default defineEventHandler(async (event) => {
  const expected = process.env.INTERNAL_CRON_SECRET
  const provided = getRequestHeader(event, 'x-internal-secret')
  if (!authorized(provided, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  let body: z.infer<typeof bodySchema> = {}
  try { body = bodySchema.parse((await readBody(event)) ?? {}) } catch {}
  const max = body.max ?? BATCH

  const supabase = await serverSupabaseClient(event)

  // No-op fast-path when the engine isn't provisioned. We still drain
  // a small batch and mark them processed so the queue doesn't grow
  // unboundedly during the pre-cutover window.
  if (!isTypesenseEnabled()) {
    const { data: rows } = await (supabase as any)
      .from('search_index_queue')
      .select('id')
      .is('processed_at', null)
      .order('enqueued_at', { ascending: true })
      .limit(Math.min(max, 100))
    const ids = (rows ?? []).map((r: any) => r.id)
    if (ids.length > 0) {
      await (supabase as any)
        .from('search_index_queue')
        .update({
          processed_at: new Date().toISOString(),
          last_error:   'typesense not configured — drained as no-op',
        })
        .in('id', ids)
    }
    return { ok: true, mode: 'disabled', drained: ids.length }
  }

  // 1) Claim a batch.
  const { data: claimed, error: claimErr } = await (supabase as any)
    .from('search_index_queue')
    .select('id, property_id, op, attempts')
    .is('processed_at', null)
    .order('enqueued_at', { ascending: true })
    .limit(max)
  if (claimErr) throw createError({ statusCode: 500, statusMessage: claimErr.message })

  if (!claimed || claimed.length === 0) {
    return { ok: true, mode: 'enabled', drained: 0 }
  }

  // 2) Coalesce per property_id, last-op-wins.
  type Claimed = { id: number; property_id: number; op: 'upsert' | 'delete'; attempts: number }
  const perProp = new Map<number, { ids: number[]; op: 'upsert' | 'delete' }>()
  for (const r of claimed as Claimed[]) {
    const existing = perProp.get(r.property_id)
    if (existing) {
      existing.ids.push(r.id)
      existing.op = r.op
    } else {
      perProp.set(r.property_id, { ids: [r.id], op: r.op })
    }
  }

  // 3) Fetch hydration data for upserts in a single trip.
  const upsertIds = Array.from(perProp.entries())
    .filter(([, v]) => v.op === 'upsert')
    .map(([k]) => k)

  let propMap = new Map<number, any>()
  let primaryByProp = new Map<number, any>()
  if (upsertIds.length > 0) {
    const { data: props } = await (supabase as any)
      .from('properties')
      .select(
        'id, name, slug, street_address, category, type, city_id, barangay_id, ' +
          'primary_listing_id, internal_authoritative, updated_at, coord',
      )
      .in('id', upsertIds)
    propMap = new Map<number, any>((props ?? []).map((p: any) => [p.id, p]))

    // Elect primary listing per property — fallback when pin is NULL.
    // Inline rather than calling the RPC per row (would be N round trips).
    const { data: listings } = await (supabase as any)
      .from('listings')
      .select(
        'id, property_id, title, description, sale_price, rent_price, ' +
          'bedrooms, bathrooms, floor_area, for_sale, for_rent, source_id, ' +
          'is_online, deleted_at, updated_at',
      )
      .in('property_id', upsertIds)
      .eq('is_online', true)
      .is('deleted_at', null)

    // Group by property; pick primary per the same rule as
    // elect_primary_listing_id: internal beats source, sale beats rent,
    // recency, id asc.
    const grouped = new Map<number, any[]>()
    for (const l of listings ?? []) {
      const arr = grouped.get(l.property_id) ?? []
      arr.push(l)
      grouped.set(l.property_id, arr)
    }
    for (const [propId, arr] of grouped.entries()) {
      arr.sort((a, b) => {
        if ((a.source_id == null) !== (b.source_id == null))
          return a.source_id == null ? -1 : 1
        if (a.for_sale !== b.for_sale) return a.for_sale ? -1 : 1
        if (a.updated_at !== b.updated_at)
          return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
        return a.id - b.id
      })
      const prop = propMap.get(propId)
      const pinId = prop?.primary_listing_id
      const pinned = pinId != null ? arr.find((l) => l.id === pinId) : null
      primaryByProp.set(propId, pinned ?? arr[0] ?? null)
    }
  }

  // 4) Optional: city / barangay name lookup for denormalization.
  const cityIds = Array.from(new Set(Array.from(propMap.values()).map((p) => p.city_id).filter(Boolean)))
  const barangayIds = Array.from(new Set(Array.from(propMap.values()).map((p) => p.barangay_id).filter(Boolean)))
  const [cityRes, barRes] = await Promise.all([
    cityIds.length
      ? (supabase as any).from('cities').select('id, name, slug').in('id', cityIds)
      : Promise.resolve({ data: [] }),
    barangayIds.length
      ? (supabase as any).from('barangays').select('id, name, slug').in('id', barangayIds)
      : Promise.resolve({ data: [] }),
  ])
  const cityMap = new Map<number, any>((cityRes.data ?? []).map((c: any) => [c.id, c]))
  const barMap = new Map<number, any>((barRes.data ?? []).map((b: any) => [b.id, b]))

  // 5) Walk per-property and call engine. Mark queue rows processed
  //    on success; bump attempts + last_error on failure.
  let success = 0
  let failure = 0
  for (const [propId, { ids, op }] of perProp.entries()) {
    if (op === 'delete') {
      const r = await deleteDocument(String(propId))
      if (r.ok) {
        await (supabase as any)
          .from('search_index_queue')
          .update({ processed_at: new Date().toISOString() })
          .in('id', ids)
        success += ids.length
      } else {
        await (supabase as any)
          .from('search_index_queue')
          .update({ last_error: r.error ?? null })
          .in('id', ids)
        failure += ids.length
      }
      continue
    }

    // op === 'upsert'
    const prop = propMap.get(propId)
    if (!prop) {
      // Property was deleted between enqueue and drain; treat as delete.
      const r = await deleteDocument(String(propId))
      await (supabase as any)
        .from('search_index_queue')
        .update({
          processed_at: r.ok ? new Date().toISOString() : null,
          last_error:   r.ok ? null : r.error ?? null,
        })
        .in('id', ids)
      if (r.ok) success += ids.length
      else failure += ids.length
      continue
    }

    const primary = primaryByProp.get(propId)
    const city = prop.city_id ? cityMap.get(prop.city_id) : null
    const bar  = prop.barangay_id ? barMap.get(prop.barangay_id) : null

    const doc: SearchDocument = {
      id: String(propId),
      property_id: propId,
      primary_listing_id: primary?.id ?? null,
      internal_authoritative: !!prop.internal_authoritative,
      title: primary?.title || prop.name || `Property ${propId}`,
      description: primary?.description ?? undefined,
      city_id: prop.city_id ?? undefined,
      city_name: city?.name ?? undefined,
      city_slug: city?.slug ?? undefined,
      barangay_id: prop.barangay_id ?? undefined,
      barangay_name: bar?.name ?? undefined,
      barangay_slug: bar?.slug ?? undefined,
      property_category: prop.category ?? undefined,
      property_type: prop.type ?? undefined,
      bedrooms: primary?.bedrooms ?? undefined,
      bathrooms: primary?.bathrooms ?? undefined,
      floor_area: primary?.floor_area ?? undefined,
      for_sale: primary?.for_sale ?? undefined,
      for_rent: primary?.for_rent ?? undefined,
      sale_price: primary?.sale_price ?? undefined,
      rent_price: primary?.rent_price ?? undefined,
      source_ids: primary?.source_id != null ? [primary.source_id] : undefined,
      updated_at: prop.updated_at ? Math.floor(new Date(prop.updated_at).getTime() / 1000) : undefined,
    }

    const r = await upsertDocument(doc)
    if (r.ok) {
      await (supabase as any)
        .from('search_index_queue')
        .update({ processed_at: new Date().toISOString() })
        .in('id', ids)
      success += ids.length
    } else {
      await (supabase as any)
        .from('search_index_queue')
        .update({ last_error: r.error ?? null })
        .in('id', ids)
      failure += ids.length
      logger.warn(
        { err: r.error, op: 'internal.index_search_queue.upsert', property_id: propId },
        'search_index_upsert_failed',
      )
    }
  }

  return { ok: true, mode: 'enabled', success, failure, batch: claimed.length }
})
