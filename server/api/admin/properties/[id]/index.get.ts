// Admin — property detail with all variant listings.
//
// GET /api/admin/properties/:id
//
// Returns the property row + the listings that share its property_id
// (the variants) + the elected primary fallback id. Drives
// /admin/properties/[id].vue.

import { z as _z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

// Drift-safe column projection. listings.source_id was added by mig
// 506000013; environments without that mig still need this endpoint
// to work, so we project a generous fallback set.
const LISTING_COLS = [
  'id',
  'property_id',
  'title',
  'sale_price',
  'rent_price',
  'bedrooms',
  'bathrooms',
  'floor_area',
  'lot_area',
  'parking_spaces',
  'is_online',
  'deleted_at',
  'duplicate_of_id',
  'source_id',
  'foreign_id',
  'created_by',
  'created_at',
  'updated_at',
].join(', ')

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const propertyId = Number(getRouterParam(event, 'id') || '0')
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid property id' })
    }

    const supabase = await serverSupabaseClient(event)

    const { data: property, error: pErr } = await (supabase as any)
      .from('properties')
      .select(
        'id, name, slug, street_address, category, type, year_built, ' +
          'city_id, barangay_id, developer_id, ' +
          'primary_listing_id, internal_authoritative, ' +
          'created_at, updated_at',
      )
      .eq('id', propertyId)
      .maybeSingle()

    if (pErr) throw createError({ statusCode: 500, statusMessage: pErr.message })
    if (!property) throw createError({ statusCode: 404, statusMessage: 'Property not found' })

    // Variants — every listing sharing this property_id, live or dead.
    const { data: variantsRaw, error: vErr } = await (supabase as any)
      .from('listings')
      .select(LISTING_COLS)
      .eq('property_id', propertyId)
      .order('is_online', { ascending: false })
      .order('updated_at', { ascending: false })
    if (vErr) throw createError({ statusCode: 500, statusMessage: vErr.message })

    const variants = variantsRaw ?? []

    // Resolve broker names + source labels in one round-trip each.
    const brokerIds = Array.from(
      new Set(variants.map((l: any) => l.created_by).filter(Boolean)),
    ) as string[]
    const sourceIds = Array.from(
      new Set(variants.map((l: any) => l.source_id).filter(Boolean)),
    ) as number[]

    const [brokersRes, sourcesRes, electedRes, cityRes, barangayRes] = await Promise.all([
      brokerIds.length > 0
        ? (supabase as any).from('profiles').select('id, full_name, email').in('id', brokerIds)
        : Promise.resolve({ data: [] }),
      sourceIds.length > 0
        ? (supabase as any)
            .from('listing_sources')
            .select('id, slug, display_name')
            .in('id', sourceIds)
            .then((r: any) => (r.error ? { data: [] } : r))
        : Promise.resolve({ data: [] }),
      // elect_primary_listing_id is the fallback when primary_listing_id is NULL.
      (supabase as any).rpc('elect_primary_listing_id', { p_property_id: propertyId }),
      property.city_id
        ? (supabase as any)
            .from('cities')
            .select('id, name, slug')
            .eq('id', property.city_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      property.barangay_id
        ? (supabase as any)
            .from('barangays')
            .select('id, name, slug')
            .eq('id', property.barangay_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    const brokerMap = new Map<string, any>(
      (brokersRes.data ?? []).map((b: any) => [b.id, b]),
    )
    const sourceMap = new Map<number, any>(
      (sourcesRes.data ?? []).map((s: any) => [s.id, s]),
    )

    const enrichedVariants = variants.map((v: any) => ({
      ...v,
      broker: v.created_by ? brokerMap.get(v.created_by) ?? null : null,
      source: v.source_id ? sourceMap.get(v.source_id) ?? null : null,
      is_primary_pin: property.primary_listing_id === v.id,
    }))

    return {
      property: {
        ...property,
        city:     cityRes.data ?? null,
        barangay: barangayRes.data ?? null,
      },
      variants:                  enrichedVariants,
      elected_primary_listing_id: electedRes.data ?? null,
    }
  },
})
