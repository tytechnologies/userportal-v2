import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { refreshListingDetails } from '~~/server/utils/refresh-listing-details'
import { dispatchWebhook } from '~~/server/utils/webhooks'

// Columns slated for removal in migrations 20260429000003 (contact denorm) and
// 20260429000004 (city/barangay denorm). They must NOT appear in any insert /
// update payload â€” the migrations refuse to apply if recent rows still hold
// values here. The contact_* set is sourced from contacts via contact_id; the
// location set is sourced from cities/barangays via city_id/barangay_id.
const LEGACY_LISTING_FIELDS = [
  'contact_name',
  'contact_designation',
  'contact_email',
  'contact_home_phone',
  'contact_mobile_number',
  'contact_link',
  'contact_notes',
  'city_name',
  'city_slug',
  'barangay_name',
] as const

function forbidLegacyFields(payload: Record<string, unknown>, op: string) {
  const offending = LEGACY_LISTING_FIELDS.filter((f) => f in payload)
  if (offending.length > 0) {
    logger.error(
      { op, offending },
      'listings_legacy_field_write_blocked',
    )
    throw createError({
      statusCode: 400,
      statusMessage: `Legacy listings field(s) ${offending.join(
        ', ',
      )} are no longer writable. Use contact_id / city_id / barangay_id.`,
    })
  }
}

// PostgREST relational select string used by both list() and getById(). Kept
// at module scope so the API surface stays in sync â€” adding a column to one
// path is automatically picked up by the other.
//
// The contact / city / barangay joins replace the denormalized columns being
// dropped by migrations 20260429000003 + 20260429000004. After those land,
// the only place these names live is on the parent rows (contacts.full_name,
// cities.name, barangays.name) â€” the listings row carries the FKs, the joins
// surface the names for display.
const LISTING_RELATIONAL_SELECT = `
  *,
  creator:profiles!listings_created_by_fk (id, full_name, email, avatar_url),
  contact:contacts!contact_id (id, full_name, email, mobile_phone, designation),
  city:cities!city_id (id, name, slug),
  barangay:barangays!barangay_id (id, name, slug)
`

// Single source of truth for the flattened display fields. Any consumer that
// reads listing.contact_name, listing.city_name, listing.barangay_name today
// keeps working â€” but the value is always derived from the join, never from
// the same-named columns on listings (which are about to disappear).
function flattenListingRelations<T extends Record<string, any>>(row: T) {
  return {
    ...row,
    created_by_name:
      row.creator?.full_name ??
      row.creator?.email ??
      row.created_by_legacy ??
      'Data not available',
    contact_name: row.contact?.full_name ?? null,
    contact_email: row.contact?.email ?? null,
    city_name: row.city?.name ?? null,
    city_slug: row.city?.slug ?? null,
    barangay_name: row.barangay?.name ?? null,
  }
}

type Ctx = { event: H3Event; id: number }

type ListParams = {
  event: H3Event
  page?: number | string
  pageSize?: number | string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  filters: Record<string, unknown>
}

export const listingsRepo = {
  async list({ event, page, pageSize, sortBy, sortOrder, filters }: ListParams) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const limit = parseInt(pageSize as string, 10) || 10
    const offset = ((parseInt(page as string, 10) - 1) || 0) * limit

    // PostgREST relational select: pull the creator profile + linked contact
    // + city + barangay in a single round trip. Replaces the N+1 client-side
    // enrichment pass (`enrichListingsWithUserNames`) and the denormalized
    // *_name columns. Nullable joins â€” listings without a matching profile
    // (legacy data still in created_by_legacy) just get creator: null, which
    // the response transformer handles gracefully.
    let query: any = client
      .from('listings')
      .select(LISTING_RELATIONAL_SELECT, { count: 'exact' })

    if (filters.search) {
      const search = String(filters.search)
      query = query.or(
        `listing_title.ilike.%${search}%,description.ilike.%${search}%,unit_number.ilike.%${search}%`,
      )
    }

    // Ownership scope (Phase 4). Layered on top of RLS â€” RLS already
    // restricts what an agent can see; this just lets the UI further
    // narrow to "my listings" or "team listings" without reissuing the
    // request shape.
    if (filters.ownership === 'mine' && user?.id) {
      query = query.eq('created_by', user.id)
    } else if (filters.ownership === 'team') {
      // Resolve the caller's team_id, then match listings whose creator
      // shares that team. NULL team_id means "no team" â€” we narrow by
      // explicit equality to avoid leaking listings from other teams.
      const { data: prof } = await (client as any)
        .from('profiles')
        .select('team_id')
        .eq('id', user?.id ?? '')
        .maybeSingle()
      const teamId = prof?.team_id ?? null
      if (teamId) {
        const { data: teammates } = await (client as any)
          .from('profiles')
          .select('id')
          .eq('team_id', teamId)
        const ids = (teammates ?? []).map((p: any) => p.id).filter(Boolean)
        if (ids.length > 0) {
          query = query.in('created_by', ids)
        } else if (user?.id) {
          // Fallback: just the caller's own rows.
          query = query.eq('created_by', user.id)
        }
      } else if (user?.id) {
        query = query.eq('created_by', user.id)
      }
    }

    if (filters.forId) query = query.eq('for', filters.forId)
    if (filters.typeId) query = query.eq('type', filters.typeId)
    if (filters.conditionId) query = query.eq('condition', filters.conditionId)

    const parkingRaw = (filters.parking_spaces ?? filters.parking) as any
    if (parkingRaw !== undefined && parkingRaw !== null && parkingRaw !== '') {
      const parkingNumber = parseInt(String(parkingRaw), 10)
      if (!Number.isNaN(parkingNumber)) query = query.eq('parking_spaces', parkingNumber)
    }

    if (filters.availabilityFrom) query = query.gte('availability_date', filters.availabilityFrom)
    if (filters.availabilityTo) query = query.lte('availability_date', filters.availabilityTo)

    if (filters.minBedroom) query = query.gte('bedrooms', filters.minBedroom)
    if (filters.maxBedroom) query = query.lte('bedrooms', filters.maxBedroom)
    if (filters.minBathroom) query = query.gte('bathrooms', filters.minBathroom)
    if (filters.maxBathroom) query = query.lte('bathrooms', filters.maxBathroom)

    if (filters.minPrice) query = query.gte('price', filters.minPrice)
    if (filters.maxPrice) query = query.lte('price', filters.maxPrice)
    if (filters.minPps) query = query.gte('price_per_sqm', filters.minPps)
    if (filters.maxPps) query = query.lte('price_per_sqm', filters.maxPps)
    if (filters.minFloorArea) query = query.gte('floor_area', filters.minFloorArea)
    if (filters.maxFloorArea) query = query.lte('floor_area', filters.maxFloorArea)
    if (filters.minLotArea) query = query.gte('lot_area', filters.minLotArea)
    if (filters.maxLotArea) query = query.lte('lot_area', filters.maxLotArea)

    query = query.range(offset, offset + limit - 1)
    if (sortBy && sortOrder) query = query.order(sortBy, { ascending: sortOrder === 'asc' })

    const { data, error, count } = await query
    if (error) {
      logger.error({ err: error.message, op: 'listings.list' }, 'listings_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Flatten the joins via the shared helper so list() and getById() return
    // identical shapes. `creator` / `contact` / `city` / `barangay` stay on
    // the row as nested objects for callers that want them.
    const enriched = (data ?? []).map((row: any) => flattenListingRelations(row))

    return {
      data: enriched,
      total: count || 0,
      page: parseInt(page as string, 10) || 1,
      pageSize: limit,
      totalPages: count ? Math.ceil(count / limit) : 0,
    }
  },

  async getById({ event, id }: Ctx) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await client
      .from('listings')
      .select(LISTING_RELATIONAL_SELECT)
      .eq('id', id)
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'listings.getById', id }, 'listings_get_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    return flattenListingRelations(data as any)
  },

  async create({ event, input }: { event: H3Event; input: Record<string, unknown> }) {
    forbidLegacyFields(input, 'listings.create')
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    // Stamp created_by / updated_by from the authenticated user. RLS also
    // enforces this â€” callers cannot land a row owned by someone else.
    const payload = {
      ...input,
      created_by: input.created_by ?? user?.id ?? null,
      updated_by: input.updated_by ?? user?.id ?? null,
    }

    const { data, error } = await client.from('listings').insert(payload).select().single()
    if (error) {
      logger.error({ err: error.message, op: 'listings.create' }, 'listings_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    await refreshListingDetails(client, 'listings.create')
    await logActivity({
      event,
      client,
      action: 'listing.created',
      entity: 'listing',
      // contact_id is included whenever the listing references one â€” the
      // unified CRM timeline pivots on metadata.contact_id to surface
      // listing events in the related contact's feed.
      metadata: {
        listing_id: data?.id,
        title: data?.title ?? null,
        contact_id: (data as any)?.contact_id ?? (payload as any).contact_id ?? null,
      },
    })

    // Outbound webhook fan-out. Fire-and-forget â€” the user-visible
    // create response should not wait on partner endpoints. .catch()
    // is required (see CONTRIBUTING â€” `void <promise>` leaves
    // rejections unhandled).
    dispatchWebhook('listing.created', {
      listing_id: data?.id,
      title: data?.title ?? null,
      property_category: (data as any)?.property_category ?? null,
      property_type: (data as any)?.property_type ?? null,
      sale_price: (data as any)?.sale_price ?? null,
      rent_price: (data as any)?.rent_price ?? null,
      contact_id: (data as any)?.contact_id ?? null,
      created_by: (data as any)?.created_by ?? null,
      created_at: (data as any)?.created_at ?? null,
    }).catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          op: 'listings.create.webhook_dispatch',
          listing_id: data?.id,
        },
        'listing_created_webhook_dispatch_threw',
      )
    })

    return data
  },

  async archive({ event, id }: Ctx) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const { data, error } = await client
      .from('listings')
      .update({ is_online: false, updated_by: user?.id ?? null })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'archive', id }, 'listing_archive_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    await refreshListingDetails(client, 'listings.archive')
    await logActivity({
      event,
      client,
      action: 'listing.archived',
      entity: 'listing',
      metadata: { listing_id: id, contact_id: data.contact_id ?? null },
    })

    dispatchWebhook('listing.archived', {
      listing_id: id,
      title: (data as any)?.title ?? null,
      contact_id: data.contact_id ?? null,
      archived_at: new Date().toISOString(),
    }).catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          op: 'listings.archive.webhook_dispatch',
          listing_id: id,
        },
        'listing_archived_webhook_dispatch_threw',
      )
    })

    return data
  },

  async unarchive({ event, id }: Ctx) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const { data, error } = await client
      .from('listings')
      .update({ is_online: true, updated_by: user?.id ?? null })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'unarchive', id }, 'listing_unarchive_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    await refreshListingDetails(client, 'listings.unarchive')
    await logActivity({
      event,
      client,
      action: 'listing.unarchived',
      entity: 'listing',
      metadata: { listing_id: id, contact_id: data.contact_id ?? null },
    })
    return data
  },

  async updateRemarks({ event, id, remarks }: Ctx & { remarks: string }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const { data, error } = await client
      .from('listings')
      .update({ remarks, updated_by: user?.id ?? null })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'updateRemarks', id }, 'listing_remarks_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    await refreshListingDetails(client, 'listings.updateRemarks')
    await logActivity({
      event,
      client,
      action: 'listing.remarks_updated',
      entity: 'listing',
      metadata: {
        listing_id: id,
        contact_id: data.contact_id ?? null,
        length: remarks?.length ?? 0,
      },
    })
    return data
  },

  async softDelete({ event, id }: Ctx) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const { data, error } = await client
      .from('listings')
      .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'softDelete', id }, 'listing_soft_delete_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
    await refreshListingDetails(client, 'listings.softDelete')
    await logActivity({
      event,
      client,
      action: 'listing.soft_deleted',
      entity: 'listing',
      metadata: { listing_id: id, contact_id: data.contact_id ?? null },
    })
    return data
  },

  async clone({ event, id }: Ctx) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const { data: source, error: fetchError } = await client
      .from('listings')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      logger.error({ err: fetchError.message, op: 'clone.fetch', id }, 'listing_clone_fetch_failed')
      throw createError({ statusCode: 500, statusMessage: fetchError.message })
    }
    if (!source) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })

    // Whitelist of cloneable fields. Excludes id, created_at, updated_at,
    // deleted_at, deleted_by. created_by/updated_by use the authenticated user
    // (preserving source values would let a user clone someone else's listing
    // under their name).
    //
    // Normalized: contact_id is the only contact reference written â€” the 7
    // contact_* text columns are slated for removal (migration E). Same for
    // city_id / barangay_id over city_name / city_slug / barangay_name
    // (migration F). If `source` still has those legacy values from old rows,
    // we deliberately do not propagate them; the FKs are the source of truth.
    const clonePayload: Record<string, unknown> = {
      property_id: source.property_id,
      property_category: source.property_category || 'residential',
      contact_id: source.contact_id,
      city_id: source.city_id,
      barangay_id: source.barangay_id,
      title: `${source.title ?? ''} (Clone)`,
      status: source.status,
      condition: source.condition,
      description: source.description,
      unit_number: source.unit_number,
      is_online: source.is_online,
      for_sale: source.for_sale,
      for_rent: source.for_rent,
      sale_price: source.sale_price,
      rent_price: source.rent_price,
      sale_price_per_sqm: source.sale_price_per_sqm,
      rent_price_per_sqm: source.rent_price_per_sqm,
      bedrooms: source.bedrooms,
      bathrooms: source.bathrooms,
      floor_area: source.floor_area,
      lot_area: source.lot_area,
      parking_spaces: source.parking_spaces,
      lease_term: source.lease_term,
      rent_advance: source.rent_advance,
      security_deposit: source.security_deposit,
      association_dues: source.association_dues,
      availability_date: source.availability_date,
      remarks: source.remarks,
      street_address: source.street_address,
      developer_name: source.developer_name,
      property_name: source.property_name,
      property_type: source.property_type,
      year_built: source.year_built,
      coord: source.coord,
      thumbnail: source.thumbnail,
      created_by: user?.id ?? source.created_by,
      updated_by: user?.id ?? source.updated_by,
    }

    forbidLegacyFields(clonePayload, 'listings.clone')

    const { data: cloned, error: insertError } = await client
      .from('listings')
      .insert(clonePayload)
      .select()
      .single()

    if (insertError) {
      logger.error({ err: insertError.message, op: 'clone.insert', id }, 'listing_clone_insert_failed')
      throw createError({ statusCode: 500, statusMessage: insertError.message })
    }

    await refreshListingDetails(client, 'listings.clone')
    await logActivity({
      event,
      client,
      action: 'listing.cloned',
      entity: 'listing',
      metadata: {
        listing_id: cloned?.id,
        source_listing_id: id,
        contact_id: cloned?.contact_id ?? null,
      },
    })
    return cloned
  },
}
