import { fetchImageUrls } from './listings/imageDownload'
import { getImageThumbnail } from './listings/getImageThumbnail'
import { deleteImages } from './listings/deleteImages'
import { getGalleryImages } from './listings/getGalleryImages'
import { UrlBuilder } from '@innova2/url-builder'
import axios from 'axios'
import ImagesController from './images/imagesController'
import DisplayedImagesController from './images/displayedImagesController'
import dbImagesEngine from './images/dbImagesEngine'

/**
 * Use the current supabase authenticated session.
 * @returns {object|null} The Supabase client instance if session is set, otherwise null.
 */
async function authenticatedSupabaseClient() {
  const session = useSupabaseSession()

  if (!session.value) {
    console.error(
      'Auth Error: No active session found. Cannot make authenticated request.'
    )
    return null
  }

  // The @nuxtjs/supabase module already manages the session via cookies +
  // auto-refresh. Returning the module client is enough; manual setSession
  // here used to fight the module's refresh logic and caused intermittent 401s.
  return useSupabaseClient()
}

// Columns being dropped by migrations 20260429000003 / 000004. The form must
// only write contact_id / city_id / barangay_id; if anything tries to send
// these denormalized aliases, we want a loud client-side error before they
// reach Supabase. Guard runs in both insert and update paths.
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
]

function assertNoLegacyFields(payload, op) {
  if (!payload || typeof payload !== 'object') return
  const offending = LEGACY_LISTING_FIELDS.filter((f) =>
    Object.prototype.hasOwnProperty.call(payload, f),
  )
  if (offending.length > 0) {
    const msg = `Legacy listings field(s) ${offending.join(
      ', ',
    )} are no longer writable (op=${op}). Use contact_id / city_id / barangay_id.`
    console.error(msg, { payloadKeys: Object.keys(payload) })
    throw new Error(msg)
  }
}

// Fire-and-await the materialized-view refresh after a successful mutation.
// Called from _createListingOnly / _updateListing because those write to
// Supabase directly (bypassing the listings repo, which refreshes inline).
// Failures are logged but never re-thrown — a stale view is a degraded read,
// not a broken write, and the user-facing flow already saw the success.
async function refreshListingDetailsFromClient(op) {
  try {
    await $fetch('/api/admin/refresh-listing-details', { method: 'POST' })
  } catch (err) {
    console.warn(`[refresh-listing-details] op=${op} failed`, err)
  }
}

/**
 * Helper function to enrich listings with user names
 * @param {Array} listings - Array of listing objects
 * @param {object} supabase - Supabase client instance
 * @returns {Promise<Array>} - Listings enriched with created_by_name
 */
// Caches the table-missing signal so we don't spam 404s if Phase B (the
// public.profiles migration) hasn't been applied yet. See supabase/MIGRATIONS.md.
let profilesTableMissing = false

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function enrichListingsWithUserNames(listings, supabase) {
  if (!listings || listings.length === 0) return listings

  // Only legitimate UUIDs map to profile rows. Legacy name-string values
  // (audit D1) get echoed as-is until Phase C reconciles them.
  const userIds = [
    ...new Set(
      listings
        .map((l) => l.created_by)
        .filter((v) => typeof v === 'string' && UUID_RE.test(v)),
    ),
  ]

  const fallback = () =>
    listings.map((listing) => ({
      ...listing,
      created_by_name: listing.created_by
        ? String(listing.created_by)
        : 'Data not available',
    }))

  if (userIds.length === 0 || profilesTableMissing) {
    return fallback()
  }

  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', userIds)

    if (error) {
      // PostgREST 404 / 42P01 means the relation isn't there. Set the flag
      // so subsequent calls short-circuit instead of repeating the request.
      if (
        error.code === 'PGRST302' ||
        error.code === '42P01' ||
        error.message?.includes('not found')
      ) {
        profilesTableMissing = true
      }
      console.warn('enrichListingsWithUserNames: profiles fetch failed; falling back', error.message)
      return fallback()
    }

    const byId = new Map(
      (profiles ?? []).map((p) => [p.id, p.full_name || p.email || p.id]),
    )
    return listings.map((listing) => ({
      ...listing,
      created_by_name:
        byId.get(listing.created_by) ?? listing.created_by ?? 'Data not available',
    }))
  } catch (err) {
    console.error('Error enriching listings with user names:', err)
    return fallback()
  }
}

export default {
  /**
   * Retrieves a listing by its ID.
   * @param {number} listing_id - The ID of the listing.
   * @returns {Promise<{ data: any }>} - A promise that resolves to an object containing the listing data.
   */
  async _getGalleryImages(listing_id) {
    try {
      // Use server API instead of direct S3 access for security
      const response = await $fetch('/api/listings/get-gallery-images', {
        method: 'POST',
        body: { listingId: listing_id }
      })

      if (response.success && response.data) {
        return response.data
      }
      
      console.warn('No images found for listing:', listing_id)
      return []
    } catch (error) {
      console.error('Error in _getGalleryImages:', error)
      // Return empty array instead of throwing to prevent UI crashes
      return []
    }
  },

  /**
   * Retrieves a listing by its ID.
   * @param {number} listing_id - The ID of the listing.
   * @returns {Promise<{ data: any }>} - A promise that resolves to an object containing the listing data.
   */
  async _getListingThumbnail(listing_id) {
    try {
      const response = await getImageThumbnail(listing_id)
      if (response.success) {
        return response.data
      } else {
        console.error('Error getting thumbnail:', response.message)
        return null
      }
    } catch (error) {
      console.error('Error in _getListingThumbnail:', error)
      return null
    }
  },

  /**
   * Retrieves a listing by its ID.
   * @param {number} id - The ID of the listing.
   * @returns {Promise<{ data: any }>} - A promise that resolves to an object containing the listing data.
   */
  async _getListing(id) {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase) return { data: null, error: 'Not Authenticated' }

    // Reads from `listing_details` (the wide denormalized view, restored
    // 2026-05-01 as the canonical read source). The view exposes
    // `listing_id` natively — no alias needed. Filter on `listing_id`
    // (not `id`) because that's the view's PK column.
    const { data: listings, error } = await supabase
      .from('listing_details')
      .select('*')
      .eq('listing_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      console.error('Error fetching listing:', error)
      return null
    }

    // Enrich single listing with user name
    const enrichedListings = await enrichListingsWithUserNames([listings], supabase)

    return { data: enrichedListings[0] }
  },

  async _getListingsByUserId(userId) {
    const nuxtApp = useNuxtApp()
    // Reads from `listing_details` (canonical read source, has listing_id
    // natively).
    const { data: listings, error } = await useSupabaseClient()
      .from('listing_details')
      .select('*')
      .limit(100)
    // .or(`created_by.eq.${userId},contact_id.eq.${userId}`)

    return { data: listings ?? [] }
  },

  async _getOtherBrokerListings() {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase) return { data: [], error: 'Not Authenticated' }

    // Reads from `listing_details` (canonical read source, has listing_id
    // natively).
    let query = supabase
      .from('listing_details')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)

    const url = new URL(window.location.href)
    const urlParams = Object.fromEntries(url.searchParams)

    if (urlParams.division) {
      query = query.eq('property_category', urlParams.division)
    }
    if (urlParams.searchText) {
      let trimmedField = ''
      let trimmedValue = ''
      const searchTextMatch = urlParams.searchText.match(/\[(.*?),(.*?)\]/)
      if (searchTextMatch) {
        const [_, field, value] = searchTextMatch
        trimmedField = field.trim()
        trimmedValue = value.trim()
        query = query.eq(trimmedField, trimmedValue)
      }
    }
    if (urlParams.forId) {
      if (urlParams.forId === 'sale') {
        query = query.eq('for_sale', true)
      } else if (urlParams.forId === 'rent') {
        query = query.eq('for_rent', true)
      }
    }
    if (urlParams.typeId) {
      query = query.eq('property_type', urlParams.typeId)
    }
    if (urlParams.parking || urlParams.parking_spaces) {
      const parkingValue = parseInt((urlParams.parking_spaces ?? urlParams.parking), 10)
      if (!Number.isNaN(parkingValue)) {
        query = query.eq('parking_spaces', parkingValue)
      }
    }
    if (urlParams.availabilityFrom) {
      query = query.gte('availability_date', urlParams.availabilityFrom)
    }
    if (urlParams.availabilityTo) {
      query = query.lte('availability_date', urlParams.availabilityTo)
    }
    if (urlParams.minBedroom) {
      query = query.gte('bedrooms', urlParams.minBedroom)
    }
    if (urlParams.maxBedroom) {
      query = query.lte('bedrooms', urlParams.maxBedroom)
    }
    if (urlParams.minPrice) {
      if (urlParams.forId === 'sale') {
        query = query.gte('sale_price', urlParams.minPrice)
      } else if (urlParams.forId === 'rent') {
        query = query.gte('rent_price', urlParams.minPrice)
      }
    }
    if (urlParams.maxPrice) {
      if (urlParams.forId === 'sale') {
        query = query.lte('sale_price', urlParams.maxPrice)
      } else if (urlParams.forId === 'rent') {
        query = query.lte('rent_price', urlParams.maxPrice)
      }
    }
    if (urlParams.minPps) {
      if (urlParams.forId === 'sale') {
        query = query.gte('sale_price_per_sqm', urlParams.minPps)
      } else if (urlParams.forId === 'rent') {
        query = query.gte('rent_price_per_sqm', urlParams.minPps)
      }
    }
    if (urlParams.maxPps) {
      if (urlParams.forId === 'sale') {
        query = query.lte('sale_price_per_sqm', urlParams.maxPps)
      } else if (urlParams.forId === 'rent') {
        query = query.lte('rent_price_per_sqm', urlParams.maxPps)
      }
    }
    if (urlParams.minFloorArea) {
      query = query.gte('floor_area', urlParams.minFloorArea)
    }
    if (urlParams.maxFloorArea) {
      query = query.lte('floor_area', urlParams.maxFloorArea)
    }
    if (urlParams.minLotArea) {
      query = query.gte('lot_area', urlParams.minLotArea)
    }
    if (urlParams.maxLotArea) {
      query = query.lte('lot_area', urlParams.maxLotArea)
    }
    if (urlParams.designation) {
      query = query.eq('contact_designation', urlParams.designation)
    }
    if (urlParams.conditionId) {
      query = query.eq('condition', urlParams.conditionId)
    }
    if (urlParams.availability) {
      switch (urlParams.availability) {
        case 'archived':
          query = query.eq('is_online', false)
          break
        case 'outdated':
          query = query.lt(
            'availability_date',
            new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
          )
          break
        default:
          query = query.eq('is_online', true)
          break
      }
    }

    const { data: listings, error } = await query

    if (error) {
      console.error('Error fetching other broker listings:', error)
      return { data: [], error }
    }

    // Enrich listings with user names
    const enrichedListings = await enrichListingsWithUserNames(listings, supabase)

    const listingsWithCategory = enrichedListings.map((listing) => ({
      ...listing,
      category: listing.property_category,
    }))

    return { data: listingsWithCategory }
  },

  async _getPaginatedListings(page = 1, pageSize = 10, filters = {}) {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase)
      return { data: [], error: 'Not Authenticated', total: 0, totalPages: 0 }

    // Read user.id from the session — it's populated as soon as the
    // Supabase cookie is set, whereas the user ref returned by
    // useSupabaseUser hydrates on a later tick. Reading from the user
    // ref produced `created_by=eq.undefined` 400s on first paint
    // because the function ran before the ref filled.
    const session = useSupabaseSession()
    const userId = session.value?.user?.id || useSupabaseUser().value?.id || null
    if (!userId) {
      return { data: [], error: null, total: 0, totalPages: 0 }
    }

    // NOTE: this is the "My properties" path — it always scopes to the
    // caller's own listings (created_by + contacts they own), regardless
    // of role. Admins who want to see every listing should toggle to
    // "All properties" on the page; that path is served by
    // _getOtherBrokerListingsPaginated and bypasses the per-user filter.

    const url = new URL(window.location.href)
    const urlParams = Object.fromEntries(url.searchParams)

    // Calculate offset
    const offset = (page - 1) * pageSize

    // First, get listing IDs where user is the creator (from listings table where created_by = user.id)
    const { data: createdListingIds, error: createdError } = await supabase
      .from('listings')
      .select('id')
      .eq('created_by', userId)
      .is('deleted_at', null)

    if (createdError && createdError.code !== 'PGRST116') {
      console.error('Error fetching created listings:', createdError)
    }

    // Get all contacts owned by the user
    const { data: userContacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id')
      .eq('owner_user_id', userId)

    if (contactsError && contactsError.code !== 'PGRST116') {
      console.error('Error fetching user contacts:', contactsError)
    }

    const userContactIds = userContacts?.map(c => c.id) || []

    // Get listings linked to those contacts
    const { data: contactListingIds, error: contactListingError } = await supabase
      .from('listings')
      .select('id')
      .in('contact_id', userContactIds.length > 0 ? userContactIds : [-1])  // Use impossible ID if no contacts

    if (contactListingError && contactListingError.code !== 'PGRST116') {
      console.error('Error fetching contact listings:', contactListingError)
    }

    // Combine both listing ID arrays and remove duplicates
    const createdIds = createdListingIds?.map(l => l.id) || []
    const contactIds = contactListingIds?.map(l => l.id) || []
    const allUserListingIds = [...new Set([...createdIds, ...contactIds])]

    // If no listings found, return empty
    if (allUserListingIds.length === 0) {
      return { data: [], error: null, total: 0, totalPages: 0 }
    }

    // Reads from `listing_details` (canonical read source). The IDs we
    // filter by came from `listings` (created_by + contact_id buckets
    // above) — the view's PK column is `listing_id` so we filter on that.
    let query = supabase
      .from('listing_details')
      .select('*', { count: 'exact' })
      .in('listing_id', allUserListingIds)
      .order('updated_at', { ascending: false })

    // Apply filters
    if (urlParams.division || filters.division) {
      query = query.eq(
        'property_category',
        urlParams.division || filters.division
      )
    }

    // Handle search filters
    if (filters.searchColumn && filters.searchValue) {
      const searchValue = filters.searchValue.toLowerCase()
      const searchColumn = filters.searchColumn

      switch (searchColumn) {
        case 'listing_id':
          // UI key stays 'listing_id'; the wide view's PK column is
          // also literally `listing_id` (no aliasing required).
          query = query.eq('listing_id', parseInt(searchValue))
          break
        case 'title':
          query = query.ilike('title', `%${searchValue}%`)
          break
        case 'unit_number':
          query = query.ilike('unit_number', `%${searchValue}%`)
          break
        case 'city_name':
          query = query.ilike('city_name', `%${searchValue}%`)
          break
        case 'contact_name':
          query = query.ilike('contact_name', `%${searchValue}%`)
          break
        default:
          // If no specific column, search across multiple fields
          query = query.or(
            `title.ilike.%${searchValue}%,unit_number.ilike.%${searchValue}%,city_name.ilike.%${searchValue}%,contact_name.ilike.%${searchValue}%`
          )
          break
      }
    } else if (urlParams.searchText || filters.searchText) {
      let trimmedField = ''
      let trimmedValue = ''
      const searchTextMatch = (
        urlParams.searchText || filters.searchText
      ).match(/\[(.*?),(.*?)\]/)
      if (searchTextMatch) {
        const [_, field, value] = searchTextMatch
        trimmedField = field.trim()
        trimmedValue = value.trim()
        query = query.eq(trimmedField, trimmedValue)
      }
    }
    if (urlParams.forId || filters.forId) {
      const forId = urlParams.forId || filters.forId
      if (forId === 'sale') {
        query = query.eq('for_sale', true)
      } else if (forId === 'rent') {
        query = query.eq('for_rent', true)
      }
    }
    if (urlParams.typeId || filters.typeId) {
      query = query.eq('property_type', urlParams.typeId || filters.typeId)
    }
    if (urlParams.parking || urlParams.parking_spaces || filters.parking) {
      const rawParking = (urlParams.parking_spaces ?? urlParams.parking ?? filters.parking)
      const parkingValue = parseInt(rawParking, 10)
      if (!Number.isNaN(parkingValue)) {
        query = query.eq('parking_spaces', parkingValue)
      }
    }
    
    // Location filter - handle city, barangay, and property (building)
    if (urlParams.locationType || filters.locationType) {
      const locationType = urlParams.locationType || filters.locationType
      const locationId = urlParams.locationId || filters.locationId
      
      if (locationType === 'unit_number' && locationId) {
        // Filter by unit_number when a unit is selected
        query = query.eq('unit_number', locationId)
      } else if (locationType === 'property' && locationId) {
        // Filter by property_id when a building/property is selected
        query = query.eq('property_id', locationId)
      } else if (locationType === 'barangay' && locationId) {
        // Filter by barangay_id when a barangay is selected
        query = query.eq('barangay_id', locationId)
      } else if (locationType === 'city' && (urlParams.location || filters.location)) {
        // Filter by city_name when a city is selected
        query = query.eq('city_name', urlParams.location || filters.location)
      }
    } else if (urlParams.location || filters.location) {
      // Fallback for backward compatibility - filter by city_name
      query = query.eq('city_name', urlParams.location || filters.location)
    }
    
    if (urlParams.availabilityFrom || filters.availabilityFrom) {
      query = query.gte(
        'availability_date',
        urlParams.availabilityFrom || filters.availabilityFrom
      )
    }
    if (urlParams.availabilityTo || filters.availabilityTo) {
      query = query.lte(
        'availability_date',
        urlParams.availabilityTo || filters.availabilityTo
      )
    }
    if (urlParams.minBedroom || filters.minBedroom) {
      query = query.gte('bedrooms', urlParams.minBedroom || filters.minBedroom)
    }
    if (urlParams.maxBedroom || filters.maxBedroom) {
      query = query.lte('bedrooms', urlParams.maxBedroom || filters.maxBedroom)
    }
    if (urlParams.minBathroom || filters.minBathroom) {
      query = query.gte('bathrooms', urlParams.minBathroom || filters.minBathroom)
    }
    if (urlParams.maxBathroom || filters.maxBathroom) {
      query = query.lte('bathrooms', urlParams.maxBathroom || filters.maxBathroom)
    }
    if (urlParams.minPrice || filters.minPrice) {
      const minPrice = urlParams.minPrice || filters.minPrice
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.gte('sale_price', minPrice)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.gte('rent_price', minPrice)
      }
    }
    if (urlParams.maxPrice || filters.maxPrice) {
      const maxPrice = urlParams.maxPrice || filters.maxPrice
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.lte('sale_price', maxPrice)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.lte('rent_price', maxPrice)
      }
    }
    if (urlParams.minPps || filters.minPps) {
      const minPps = urlParams.minPps || filters.minPps
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.gte('sale_price_per_sqm', minPps)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.gte('rent_price_per_sqm', minPps)
      }
    }
    if (urlParams.maxPps || filters.maxPps) {
      const maxPps = urlParams.maxPps || filters.maxPps
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.lte('sale_price_per_sqm', maxPps)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.lte('rent_price_per_sqm', maxPps)
      }
    }
    if (urlParams.minFloorArea || filters.minFloorArea) {
      query = query.gte(
        'floor_area',
        urlParams.minFloorArea || filters.minFloorArea
      )
    }
    if (urlParams.maxFloorArea || filters.maxFloorArea) {
      query = query.lte(
        'floor_area',
        urlParams.maxFloorArea || filters.maxFloorArea
      )
    }
    if (urlParams.minLotArea || filters.minLotArea) {
      query = query.gte('lot_area', urlParams.minLotArea || filters.minLotArea)
    }
    if (urlParams.maxLotArea || filters.maxLotArea) {
      query = query.lte('lot_area', urlParams.maxLotArea || filters.maxLotArea)
    }
    if (urlParams.designation || filters.designation) {
      query = query.eq(
        'contact_designation',
        urlParams.designation || filters.designation
      )
    }
    if (urlParams.conditionId || filters.conditionId) {
      query = query.eq(
        'condition',
        urlParams.conditionId || filters.conditionId
      )
    }
    if (urlParams.availability || filters.availability) {
      const availability = urlParams.availability || filters.availability
      switch (availability) {
        case 'archived':
          query = query.eq('is_online', false)
          break
        case 'outdated':
          query = query.lt(
            'availability_date',
            new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
          )
          break
        default:
          break
      }
    }
    
    // Apply display status filter (isOnline)
    if (filters.isOnline === 'online') {
      query = query.eq('is_online', true)
    } else if (filters.isOnline === 'offline') {
      query = query.eq('is_online', false)
    }

    // Apply pagination
    query = query.range(offset, offset + pageSize - 1)

    const { data, error, count } = await query

    if (error) {
      console.error('Error fetching paginated listings:', error)
      return { data: [], error: error.message, total: 0, totalPages: 0 }
    }

    // Enrich listings with user names
    const enrichedData = await enrichListingsWithUserNames(data, supabase)

    const totalPages = Math.ceil((count || 0) / pageSize)

    return {
      data: enrichedData || [],
      total: count || 0,
      totalPages,
      currentPage: page,
      pageSize,
    }
  },

  async _getListings() {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase) return { data: [], error: 'Not Authenticated' }

    const user = useSupabaseUser()
    // Auth-race guard — see _getPaginatedListings.
    const userId = user.value?.id ?? null
    if (!userId) return { data: [], error: null }
    const url = new URL(window.location.href)
    const urlParams = Object.fromEntries(url.searchParams)

    // Reads from `listing_details` (canonical wide read source).
    let query = supabase
      .from('listing_details')
      .select('*')
      .eq('created_by', userId)
      .limit(100)

    if (urlParams.division) {
      query = query.eq('property_category', urlParams.division)
    }
    if (urlParams.searchText) {
      let trimmedField = ''
      let trimmedValue = ''
      const searchTextMatch = urlParams.searchText.match(/\[(.*?),(.*?)\]/)
      if (searchTextMatch) {
        const [_, field, value] = searchTextMatch
        trimmedField = field.trim()
        trimmedValue = value.trim()
        query = query.eq(trimmedField, trimmedValue)
      }
    }
    if (urlParams.forId) {
      if (urlParams.forId === 'sale') {
        query = query.eq('for_sale', true)
      } else if (urlParams.forId === 'rent') {
        query = query.eq('for_rent', true)
      }
    }
    if (urlParams.typeId) {
      query = query.eq('property_type', urlParams.typeId)
    }
    if (urlParams.parking || urlParams.parking_spaces) {
      const parkingValue = parseInt((urlParams.parking_spaces ?? urlParams.parking), 10)
      if (!Number.isNaN(parkingValue)) {
        query = query.eq('parking_spaces', parkingValue)
      }
    }
    if (urlParams.availabilityFrom) {
      query = query.gte('availability_date', urlParams.availabilityFrom)
    }
    if (urlParams.availabilityTo) {
      query = query.lte('availability_date', urlParams.availabilityTo)
    }
    if (urlParams.minBedroom) {
      query = query.gte('bedrooms', urlParams.minBedroom)
    }
    if (urlParams.maxBedroom) {
      query = query.lte('bedrooms', urlParams.maxBedroom)
    }
    if (urlParams.minPrice) {
      if (urlParams.forId === 'sale') {
        query = query.gte('sale_price', urlParams.minPrice)
      } else if (urlParams.forId === 'rent') {
        query = query.gte('rent_price', urlParams.minPrice)
      }
    }
    if (urlParams.maxPrice) {
      if (urlParams.forId === 'sale') {
        query = query.lte('sale_price', urlParams.maxPrice)
      } else if (urlParams.forId === 'rent') {
        query = query.lte('rent_price', urlParams.maxPrice)
      }
    }
    if (urlParams.minPps) {
      if (urlParams.forId === 'sale') {
        query = query.gte('sale_price_per_sqm', urlParams.minPps)
      } else if (urlParams.forId === 'rent') {
        query = query.gte('rent_price_per_sqm', urlParams.minPps)
      }
    }
    if (urlParams.maxPps) {
      if (urlParams.forId === 'sale') {
        query = query.lte('sale_price_per_sqm', urlParams.maxPps)
      } else if (urlParams.forId === 'rent') {
        query = query.lte('rent_price_per_sqm', urlParams.maxPps)
      }
    }
    if (urlParams.minFloorArea) {
      query = query.gte('floor_area', urlParams.minFloorArea)
    }
    if (urlParams.maxFloorArea) {
      query = query.lte('floor_area', urlParams.maxFloorArea)
    }
    if (urlParams.minLotArea) {
      query = query.gte('lot_area', urlParams.minLotArea)
    }
    if (urlParams.maxLotArea) {
      query = query.lte('lot_area', urlParams.maxLotArea)
    }
    if (urlParams.designation) {
      query = query.eq('contact_designation', urlParams.designation)
    }
    if (urlParams.conditionId) {
      query = query.eq('condition', urlParams.conditionId)
    }
    if (urlParams.availability) {
      switch (urlParams.availability) {
        case 'archived':
          query = query.eq('is_online', false)
          break
        case 'outdated':
          query = query.lt(
            'availability_date',
            new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
          )
          break
        default:
          break
      }
    }

    const { data: listings, error } = await query

    if (error) {
      console.error('Error fetching listings:', error)
      return { data: [], error }
    }

    // Enrich listings with user names
    const enrichedListings = await enrichListingsWithUserNames(listings, supabase)

    const listingsWithCategory = enrichedListings.map((listing) => ({
      ...listing,
      category: listing.property_category,
    }))

    return { data: listingsWithCategory }
  },

  async _createListing(formData, userId, images, originalImages) {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase)
      throw new Error('Authentication failed: Cannot create listing.')

    formData.created_by = userId
    formData.updated_by = userId

    const { data, error } = await supabase
      .from('listings')
      .insert(formData)
      .select()
      .single()

    if (error) {
      console.error('Error creating listing:', error)
      throw createError({
        statusCode: 500,
        statusMessage: `Failed to create listing: ${error.message}`,
        data: error,
      })
    }

    const imagesController = new ImagesController(data.id)
    await imagesController.initialize()
    await imagesController.uploadImages(images, originalImages)

    return {
      data: data,
      error: error,
    }
  },

  async _createListingOnly(formData, userId) {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase)
      throw new Error('Authentication failed: Cannot create listing.')

    assertNoLegacyFields(formData, '_createListingOnly')

    formData.created_by = userId
    formData.updated_by = userId

    const { data, error } = await supabase
      .from('listings')
      .insert(formData)
      .select()
      .single()

    if (error) {
      console.error('Error creating listing:', error)
      throw createError({
        statusCode: 500,
        statusMessage: `Failed to create listing: ${error.message}`,
        data: error,
      })
    }

    await refreshListingDetailsFromClient('_createListingOnly')

    return {
      data: data,
      error: error,
    }
  },

  async _uploadListingImages(listingId, images, originalImages, thumbnailId = null) {
    try {
      const imagesController = new ImagesController(listingId)
      await imagesController.initialize()
      await imagesController.uploadImages(images, originalImages)

      // Update thumbnail if specified
      if (thumbnailId !== null) {
        try {
          const thumbnailResults = await this._updateThumbnailSelection(
            listingId,
            thumbnailId
          )
          console.log('Thumbnail updated:', thumbnailResults)
        } catch (thumbnailError) {
          console.error('Error updating thumbnail:', thumbnailError)
        }
      }

      return { success: true }
    } catch (error) {
      console.error('Error uploading listing images:', error)
      throw error
    }
  },

  async _downloadListingImages(listingId) {
    try {
      const response = await fetchImageUrls(listingId)

      if (!response.success) {
        console.error('Error fetching listing images:', response.message)
        return []
      }

      console.log('images from listing.services.js: ', response.data)

      return response.data || []
    } catch (error) {
      console.error('Error in _downloadListingImages:', error)
      return []
    }
  },

  async _getListingImages(listingId) {
    const response = await getGalleryImages(listingId)
    if (!response.success) {
      console.error('Error fetching listing images:', response.message)
      return null
    }
    return { images: response.data, error: null }
  },

  async _getBuildingNames(_category, _type) {
    // Route through the canonical /api/buildings endpoint instead of
    // querying Supabase directly. The legacy code referenced columns
    // that have drifted off the production DB (`building_name`,
    // `property_id`, `category`, `type` — none of which exist on the
    // current schema). The API endpoint already enforces the right
    // SELECT columns + RLS + pagination, so we just adapt the
    // response shape back to the legacy { building_name, property_id }
    // contract callers (NewForm.vue) expect.
    //
    // The category/type filter args are accepted but ignored — those
    // columns don't exist on the canonical buildings table, so the
    // form receives the unfiltered list and narrows client-side via
    // its existing search box. (When category/type land on the schema,
    // bring back .eq() filtering here.)
    try {
      const res = await $fetch('/api/buildings?page=1&page_size=200')
      const reshaped = (res?.data ?? []).map((row) => ({
        ...row,
        building_name: row.name ?? '',
        property_id: row.id ?? null,
      }))
      return { data: reshaped, count: res?.total ?? reshaped.length }
    } catch (err) {
      console.error('Error fetching building names:', err)
      return null
    }
  },

  async _selectBuilding(propertyId) {
    // Same routing fix as _getBuildingNames — the API endpoint owns the
    // canonical SELECT shape.
    try {
      const row = await $fetch(`/api/buildings/${propertyId}`)
      return {
        data: {
          ...row,
          building_name: row?.name ?? row?.building_name ?? '',
          property_id: row?.id ?? row?.property_id ?? null,
        },
      }
    } catch (err) {
      console.error('Error fetching building:', err)
      return null
    }
  },

  // async _uploadListingImages(images, listingId) {
  //   const uploadedImages = []

  //   //fetch /listings/image-upload
  //   images.forEach(async (image, index) => {
  //     //convert image.file to base64
  //     console.log('image: ', image)
  //     console.log('index: ', index)
  //     const base64Image = await convertFileToBase64(image.file)

  //     const { data } = await axios.post('/api/listings/image-upload', {
  //       image: {
  //         content: base64Image,
  //         thumbnail: image.thumbnail,
  //         index: index,
  //       },
  //       listingId: listingId,
  //     })
  //     uploadedImages.push(data)
  //   })

  //   console.log('Uploaded Images: ', uploadedImages)
  //   return uploadedImages
  // },

  // async _createListing(formData) {
  //   const user = useSupabaseUser()

  //   console.log('formData from listing.services.js: ', formData)
  //   const { data, error } = await axios.post('/api/listings/create-listing', {
  //     formData: formData,
  //     userId: user.value?.id,
  //   })

  //   if (data) {
  //     console.log('Listing created successfully:', data)
  //   }

  //   if (error && !data) {
  //     console.error('Error creating listing:', error)
  //     throw new Error('Failed to create listing')
  //   }

  //   console.log('data from _createListing of listing.services.js: ', data)

  //   return data
  // },

  async _deleteListingImages(id) {
    const { data, error } = await deleteImages(id)

    if (error) {
      console.error('Error deleting listing images:', error)
      return null
    }

    return data
  },

  async _updateListing(id, formData) {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase)
      throw new Error('Authentication failed: Cannot update listing.')

    assertNoLegacyFields(formData, '_updateListing')

    const user = useSupabaseUser()

    const { data, error } = await supabase
      .from('listings')
      .update({
        ...formData,
        updated_by: user.value?.id,
      })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating listing:', error)
      throw new Error('Failed to update listing')
    }

    if (data) {
      console.log('Listing updated successfully:', data)
    }

    await refreshListingDetailsFromClient('_updateListing')

    return data
  },

  _getDeckListings(params = '') {
    const token = this.getCancelToken('getDeckListings')
    //return $fetch(`${HOST}/properties${params}`, { cancelToken: cancelTokens[cancelTokenName].token });

    if (typeof params === 'object') {
      return $fetch(apiRoutes['listings.deck'], {
        params: params,
        cancelToken: token,
      })
    } else {
      return $fetch(apiRoutes['listings.deck'] + `${params}`, {
        cancelToken: token,
      })
    }
  },

  _deleteListings(id) {
    const token = this.getCancelToken('deleteListings')
    return this.$axios.$delete(`${HOST}/properties/${id}`, {
      cancelToken: token,
    })
  },

  _archiveListing(id) {
    const token = this.getCancelToken('archiveListing')
    const body = { _method: 'PATCH', id }
    return this.$axios.$post(`${HOST}/properties/${id}/archive`, body, {
      cancelToken: token,
    })
  },

  _getSelection() {
    // WIP
    // const token = this.getCancelToken('getSelection')
    // return $fetch(apiRoutes['listings.selections'], {
    //   cancelToken: token,
    // })
  },

  _changeListingOnlineStatus(id, is_online) {
    const token = this.getCancelToken('changeListingOnlineStatus')
    const body = { _method: 'PATCH', is_online }
    return this.$axios.$post(`${HOST}/properties/${id}/online`, body, {
      cancelToken: token,
    })
  },

  async _getSuggestions(query) {
    console.log('query: ', query)
    const nuxtApp = useNuxtApp()
    const { data: suggestions, error } = await useSupabaseClient()
      .from('search_suggestions')
      .select()
      .ilike('location_name', `%${query}%`)
      .order('popularity', { ascending: false })
      .limit(10)

    if (error) {
      console.error('Error fetching suggestions:', error)
      return null
    }

    return { data: suggestions }
  },

  async _updateThumbnailSelection(listingId, newThumbnailImageId) {
    try {
      // Use server API for S3 thumbnail swap (keeps AWS credentials server-side)
      const apiResponse = await $fetch('/api/listings/update-thumbnail', {
        method: 'POST',
        body: {
          listingId: Number(listingId),
          newThumbnailImageId: Number(newThumbnailImageId),
        },
      })

      if (!apiResponse?.success || !apiResponse?.displayed || !apiResponse?.original) {
        return {
          success: false,
          displayed: apiResponse?.displayed || null,
          original: apiResponse?.original || null,
          database: null,
          error: 'Thumbnail update API did not return expected results',
        }
      }

      // Update database (listing_images) with the new thumbnail file names
      const dbEngine = new dbImagesEngine(listingId)
      const databaseResults = await dbEngine.updateThumbnailSelection(
        listingId,
        newThumbnailImageId,
        apiResponse.displayed,
        apiResponse.original
      )

      console.log('Thumbnail selection update results:', {
        displayed: apiResponse.displayed,
        original: apiResponse.original,
        database: databaseResults,
      })

      return {
        success: apiResponse.success && databaseResults?.success !== false,
        displayed: apiResponse.displayed,
        original: apiResponse.original,
        database: databaseResults,
      }
    } catch (error) {
      console.error('Error updating thumbnail selection:', error)
      throw error
    }
  },

  _getSitemap() {
    // return $fetch(baseUrl + "website/sitemap/", {
    //   method: "GET",
    //   headers: headers,
    // });
  },

  _getDivisionTypes(id) {
    console.log('service _getDivisionTypes')
    // return $fetch(baseUrl + "website/divisions/" + `${id}` + "/types", {
    //   method: "GET",
    //   headers: headers,
    // });
  },

  _recordVisit(id) {
    return $fetch(baseUrl + 'website/properties/' + `${id}` + '/visits', {
      method: 'POST',
      headers: headers,
    })
  },

  buildQueryParams(parameters) {
    let params = []
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== null && key !== 'triggered') {
        params.push(`${key}=${value}`)
      }
    }
    return '?' + params.join('&')
  },

  async _getOtherBrokerListingsPaginated(
    page = 1,
    pageSize = 10,
    filters = {}
  ) {
    const supabase = await authenticatedSupabaseClient()
    if (!supabase)
      return { data: [], error: 'Not Authenticated', total: 0, totalPages: 0 }

    const url = new URL(window.location.href)
    const urlParams = Object.fromEntries(url.searchParams)

    // Calculate offset
    const offset = (page - 1) * pageSize

    // Reads from `listing_details` (canonical wide read source).
    let query = supabase
      .from('listing_details')
      .select('*', { count: 'exact' })
      .order('updated_at', { ascending: false })

    // Apply filters
    if (urlParams.division || filters.division) {
      query = query.eq(
        'property_category',
        urlParams.division || filters.division
      )
    }

    // Handle search filters
    if (filters.searchColumn && filters.searchValue) {
      const searchValue = filters.searchValue.toLowerCase()
      const searchColumn = filters.searchColumn

      switch (searchColumn) {
        case 'listing_id':
          // UI key stays 'listing_id'; the wide view's PK column is
          // also literally `listing_id` (no aliasing required).
          query = query.eq('listing_id', parseInt(searchValue))
          break
        case 'title':
          query = query.ilike('title', `%${searchValue}%`)
          break
        case 'unit_number':
          query = query.ilike('unit_number', `%${searchValue}%`)
          break
        case 'city_name':
          query = query.ilike('city_name', `%${searchValue}%`)
          break
        case 'contact_name':
          query = query.ilike('contact_name', `%${searchValue}%`)
          break
        default:
          // If no specific column, search across multiple fields
          query = query.or(
            `title.ilike.%${searchValue}%,unit_number.ilike.%${searchValue}%,city_name.ilike.%${searchValue}%,contact_name.ilike.%${searchValue}%`
          )
          break
      }
    } else if (urlParams.searchText || filters.searchText) {
      let trimmedField = ''
      let trimmedValue = ''
      const searchTextMatch = (
        urlParams.searchText || filters.searchText
      ).match(/\[(.*?),(.*?)\]/)
      if (searchTextMatch) {
        const [_, field, value] = searchTextMatch
        trimmedField = field.trim()
        trimmedValue = value.trim()
        query = query.eq(trimmedField, trimmedValue)
      }
    }
    if (urlParams.forId || filters.forId) {
      const forId = urlParams.forId || filters.forId
      if (forId === 'sale') {
        query = query.eq('for_sale', true)
      } else if (forId === 'rent') {
        query = query.eq('for_rent', true)
      }
    }
    if (urlParams.typeId || filters.typeId) {
      query = query.eq('property_type', urlParams.typeId || filters.typeId)
    }
    // EXACT match for parking_spaces (no greater-than)
    if (urlParams.parking || urlParams.parking_spaces || filters.parking) {
      const rawParking = (urlParams.parking_spaces ?? urlParams.parking ?? filters.parking)
      const parkingValue = parseInt(rawParking, 10)
      if (!Number.isNaN(parkingValue)) {
        query = query.eq('parking_spaces', parkingValue)
      }
    }
    
    // Location filter - handle city, barangay, and property (building)
    if (urlParams.locationType || filters.locationType) {
      const locationType = urlParams.locationType || filters.locationType
      const locationId = urlParams.locationId || filters.locationId
      
      if (locationType === 'unit_number' && locationId) {
        // Filter by unit_number when a unit is selected
        query = query.eq('unit_number', locationId)
      } else if (locationType === 'property' && locationId) {
        // Filter by property_id when a building/property is selected
        query = query.eq('property_id', locationId)
      } else if (locationType === 'barangay' && locationId) {
        // Filter by barangay_id when a barangay is selected
        query = query.eq('barangay_id', locationId)
      } else if (locationType === 'city' && (urlParams.location || filters.location)) {
        // Filter by city_name when a city is selected
        query = query.eq('city_name', urlParams.location || filters.location)
      }
    } else if (urlParams.location || filters.location) {
      // Fallback for backward compatibility - filter by city_name
      query = query.eq('city_name', urlParams.location || filters.location)
    }
    
    if (urlParams.availabilityFrom || filters.availabilityFrom) {
      query = query.gte(
        'availability_date',
        urlParams.availabilityFrom || filters.availabilityFrom
      )
    }
    if (urlParams.availabilityTo || filters.availabilityTo) {
      query = query.lte(
        'availability_date',
        urlParams.availabilityTo || filters.availabilityTo
      )
    }
    if (urlParams.minBedroom || filters.minBedroom) {
      query = query.gte('bedrooms', urlParams.minBedroom || filters.minBedroom)
    }
    if (urlParams.maxBedroom || filters.maxBedroom) {
      query = query.lte('bedrooms', urlParams.maxBedroom || filters.maxBedroom)
    }
    if (urlParams.minBathroom || filters.minBathroom) {
      query = query.gte('bathrooms', urlParams.minBathroom || filters.minBathroom)
    }
    if (urlParams.maxBathroom || filters.maxBathroom) {
      query = query.lte('bathrooms', urlParams.maxBathroom || filters.maxBathroom)
    }
    if (urlParams.minPrice || filters.minPrice) {
      const minPrice = urlParams.minPrice || filters.minPrice
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.gte('sale_price', minPrice)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.gte('rent_price', minPrice)
      }
    }
    if (urlParams.maxPrice || filters.maxPrice) {
      const maxPrice = urlParams.maxPrice || filters.maxPrice
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.lte('sale_price', maxPrice)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.lte('rent_price', maxPrice)
      }
    }
    if (urlParams.minPps || filters.minPps) {
      const minPps = urlParams.minPps || filters.minPps
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.gte('sale_price_per_sqm', minPps)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.gte('rent_price_per_sqm', minPps)
      }
    }
    if (urlParams.maxPps || filters.maxPps) {
      const maxPps = urlParams.maxPps || filters.maxPps
      if (urlParams.forId === 'sale' || filters.forId === 'sale') {
        query = query.lte('sale_price_per_sqm', maxPps)
      } else if (urlParams.forId === 'rent' || filters.forId === 'rent') {
        query = query.lte('rent_price_per_sqm', maxPps)
      }
    }
    if (urlParams.minFloorArea || filters.minFloorArea) {
      query = query.gte(
        'floor_area',
        urlParams.minFloorArea || filters.minFloorArea
      )
    }
    if (urlParams.maxFloorArea || filters.maxFloorArea) {
      query = query.lte(
        'floor_area',
        urlParams.maxFloorArea || filters.maxFloorArea
      )
    }
    if (urlParams.minLotArea || filters.minLotArea) {
      query = query.gte('lot_area', urlParams.minLotArea || filters.minLotArea)
    }
    if (urlParams.maxLotArea || filters.maxLotArea) {
      query = query.lte('lot_area', urlParams.maxLotArea || filters.maxLotArea)
    }
    if (urlParams.designation || filters.designation) {
      query = query.eq(
        'contact_designation',
        urlParams.designation || filters.designation
      )
    }
    if (urlParams.conditionId || filters.conditionId) {
      query = query.eq(
        'condition',
        urlParams.conditionId || filters.conditionId
      )
    }
    if (urlParams.availability || filters.availability) {
      const availability = urlParams.availability || filters.availability
      switch (availability) {
        case 'archived':
          query = query.eq('is_online', false)
          break
        case 'outdated':
          query = query.lt(
            'availability_date',
            new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
          )
          break
        default:
          break
      }
    }
    
    // Apply display status filter (isOnline)
    if (filters.isOnline === 'online') {
      query = query.eq('is_online', true)
    } else if (filters.isOnline === 'offline') {
      query = query.eq('is_online', false)
    }

    // Apply pagination
    query = query.range(offset, offset + pageSize - 1)

    const { data, error, count } = await query

    if (error) {
      console.error('Error fetching paginated other broker listings:', error)
      return { data: [], error: error.message, total: 0, totalPages: 0 }
    }

    // Enrich listings with user names
    const enrichedData = await enrichListingsWithUserNames(data, supabase)

    const totalPages = Math.ceil((count || 0) / pageSize)

    return {
      data: enrichedData || [],
      total: count || 0,
      totalPages,
      currentPage: page,
      pageSize,
    }
  },
}
