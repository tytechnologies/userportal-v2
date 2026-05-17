<script setup lang="ts">
/**
 * AddListingWizard — six-step guided flow for creating a listing.
 *
 * Replaces the legacy NewForm.vue single-page form on /listings/new.
 * NewForm stays in place for the in-place /listings/[id] update flow
 * (it has thousands of lines of edge-case behavior we don't want to
 * break in a launch sweep). The wizard is the create-only path.
 *
 * Steps:
 *   1. Basics    — category, sale/rent, title, status, availability
 *   2. Location  — building search OR new property, city, barangay
 *   3. Pricing   — sale_price / rent_price, floor_area, lease terms
 *   4. Details   — beds / baths / parking / condition
 *   5. Photos    — upload + reorder + thumbnail + delete
 *   6. Review    — summary, Publish or Save Draft
 *
 * Validation gates:
 *   - Each Next click validates the active step's required fields.
 *     Failures render a banner at the top of the step listing every
 *     missing item; the first invalid input scrolls into view.
 *   - Publish on Review re-validates the whole form. If validation
 *     passes but no images were uploaded, the wizard auto-downgrades
 *     to draft (`is_online = false`) and tells the user why. If
 *     images exist but no thumbnail was designated, the user is
 *     blocked until they tap a star.
 *
 * Submit calls into the existing ListingService — same contract as
 * NewForm — so the upload pipeline (S3, watermark-bypass, thumbnail
 * stamp) stays unchanged.
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ListingService from '~/services/listing.services'
import { showToast } from '~/helpers/helpers'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'
import ListingHistoryDrawer from '~/components/listings/ListingHistoryDrawer.vue'

// When `listingId` is set, the wizard switches to edit mode:
// hydrates form fields from the existing listing, fetches existing
// images for the photo step, branches submit to _updateListing, and
// surfaces a "View history" button (ListingHistoryDrawer) in the
// header. Existing audit infrastructure (listings_audit_diff trigger,
// /api/listings/[id]/activities) records every save automatically —
// no extra logging code needed here.
const props = defineProps<{
  listingId?: number | null
}>()
const isEdit = computed(() => Number.isFinite(props.listingId) && (props.listingId as number) > 0)

type StepId = 1 | 2 | 3 | 4 | 5 | 6
type City = { id: number; name: string }
type Barangay = { id: number; name: string; city_id: number }
type Building = { id: number; building_name: string; city_id?: number | null }
type Contact = { id: number; full_name: string; email?: string | null }
// property_types is a canonical lookup (db-main-reference/tables.sql).
// id is a VARCHAR(20) slug like 'condo' / 'house' / 'office'; it FKs
// from listings.property_type AND properties.type, so the wizard MUST
// bind dropdown values to id, not display_name (display strings cause
// fk_properties_property_type violations on insert).
type PropertyType = {
  id: string
  display_name: string | null
  property_category: 'residential' | 'commercial'
  is_building: boolean
}
/** Amenity row as returned by the public.amenities_usage view. The
 *  view enriches the catalog with per-category counts so the picker
 *  can hide amenities nobody has ever attached to e.g. a commercial
 *  listing. Same shape NewForm has been consuming for years. */
type Amenity = {
  amenity_id: number
  amenity_name: string
  residential_listings: number | null
  commercial_listings: number | null
}
type WizardImage = {
  id: number
  name: string
  file: File
  dataUrl: string
  thumbnail: boolean
}

const router = useRouter()
const supabase = useSupabaseClient()
const user = useSupabaseUser()

const step = ref<StepId>(1)
const isSaving = ref(false)

// Edit-mode hydration. While `loadingExisting` is true the form
// renders normally but inputs are visually "loading". Set to false
// once the existing listing + its images + its amenities have all
// arrived (or any of them has soft-failed). Create mode skips this
// entirely and stays at false from the start.
const loadingExisting = ref(false)
const historyDrawerOpen = ref(false)

// Existing displayed images — populated only in edit mode. Each
// entry tracks the S3 key (for delete-by-keys), the signed URL (for
// preview), whether it's the current canonical thumbnail, and a
// per-row markedForDelete flag the operator can toggle. Submit
// processes deletions BEFORE uploads so the new thumbnail wins.
type ExistingImage = {
  key: string
  signedUrl: string
  isThumbnail: boolean
  markedForDelete: boolean
}
const existingImages = ref<ExistingImage[]>([])
/** Tracks which existing image (by S3 key) the operator has elected
 *  to make the new thumbnail. Empty string = no change. */
const existingThumbnailNext = ref<string>('')

// Banner state — populated by validateStep / publish. Cleared as soon
// as the user moves the step or fixes the highlighted fields. The list
// is rendered as a top-of-step alert so the user sees exactly what's
// missing without hunting for red borders.
const stepErrors = ref<string[]>([])

// Lookup data — cities + barangays + buildings + contacts. Loaded
// lazily on mount; the wizard renders happily before they arrive
// (selects show "Loading…" placeholders).
const cities = ref<City[]>([])
const barangays = ref<Barangay[]>([])
const buildings = ref<Building[]>([])
const contacts = ref<Contact[]>([])
const amenities = ref<Amenity[]>([])
// Loaded from public.property_types so the wizard's dropdown values
// always match what the FK constraint accepts. Falls back to the
// hardcoded display-string lists below ONLY if the DB load fails AND
// the operator chooses to proceed anyway — but in that case the
// submit will still fail with fk_properties_property_type until the
// table is reachable. (The fallback exists so the wizard renders;
// the canonical fix is fetching the DB lookup.)
const propertyTypes = ref<PropertyType[]>([])
const lookupsLoading = ref(true)

// Selected amenity ids — flat array of amenity_id values. Persisted
// post-create as parallel listing_amenities inserts (one row per id).
// Mirrors the legacy NewForm shape so the existing `listings_amenities`
// view + listing-details code keeps working.
const selectedAmenities = ref<number[]>([])

type LeaseUnit = 'months' | 'years'

const form = ref({
  // Step 1 — Basics
  category: null as 'residential' | 'commercial' | null,
  for_sale: 0 as 0 | 1,
  for_rent: 1 as 0 | 1,
  building_type: '',
  title: '',
  /** Public-facing description (rendered on the website's listing
   *  page + in syndication feeds). Restored from NewForm — was a
   *  glaring omission in the wizard. */
  description: '',
  status: 'available' as string,
  availability_date: '' as string,
  contact_id: null as number | null,

  // Step 2 — Location
  building_id: null as number | null,
  building_name_input: '',
  property_owner: '',
  /** Developer/operator name (e.g. "Ayala Land", "Megaworld"). Surfaces
   *  on the website + powers branded-residence detection. */
  developer_name: '',
  /** Year the building was constructed. Common buyer filter. */
  year_built: null as number | null,
  city_id: null as number | null,
  barangay_id: null as number | null,
  street_address: '',
  unit_number: '',

  // Step 3 — Pricing
  sale_price: '' as string | number,
  rent_price: '' as string | number,
  /** Original (pre-discount) prices. When set + below current price,
   *  the website renders a "Reduced from ₱X" tag. Persisted into
   *  listings.original_sale_price / original_rent_price. */
  original_sale_price: '' as string | number,
  original_rent_price: '' as string | number,
  floor_area: '' as string | number,
  lot_area: '' as string | number,
  association_dues: '' as string | number,
  rent_advance: 1,
  security_deposit: 2,
  lease_term: 12 as number,
  /** UI-only unit toggles. Submit converts to months. */
  lease_term_unit: 'months' as LeaseUnit,
  rent_advance_unit: 'months' as LeaseUnit,
  security_deposit_unit: 'months' as LeaseUnit,

  // Step 4 — Details
  bedrooms: 0,
  bathrooms: 0,
  parking_spaces: 0,
  condition: '' as string,
  /** Commercial-specific extras. Persisted as listings.attributes.commercial.*.
   *  All optional; the entire block is hidden when category != commercial. */
  commercial_building_class: '' as string,
  commercial_aircon: '' as string,
  commercial_aircon_operation: '' as string,
  commercial_escalation: '' as string | number,
  commercial_telcos: '' as string,
  commercial_office_floor: '' as string,
  commercial_office_type: '' as string,
  commercial_office_setup: '' as string,
  commercial_occupant_number: '' as string | number,

  // Step 5 — Photos & Media
  images: [] as WizardImage[],
  /** Media embed ids. Persisted as listings.attributes.media.{youtube_id, slideshare_id}.
   *  Visible on the website's property page when set. */
  youtube_id: '',
  slideshare_id: '',
  remarks: '',
})

const STATUS_OPTIONS = [
  { value: 'available', label: 'Available' },
  { value: 'on-hold', label: 'On hold' },
  { value: 'under-negotiation', label: 'Under negotiation' },
] as const

// listing_condition is a Postgres enum (db-main-reference/listings.sql:10-18)
// with seven canonical slugs. Wizard MUST bind to .value (the slug)
// because the column is enum-typed — writing the display string returns
// '22P02 invalid input value for enum listing_condition'. STATUS_OPTIONS
// above uses the same { value, label } shape for the same reason.
const CONDITION_OPTIONS = [
  { value: 'unfurnished',     label: 'Unfurnished' },
  { value: 'semi-furnished',  label: 'Semi-furnished' },
  { value: 'fully-furnished', label: 'Fully-furnished' },
  { value: 'bare-shell',      label: 'Bare shell' },
  { value: 'warm-shell',      label: 'Warm shell' },
  { value: 'fitted-out',      label: 'Fitted out' },
  { value: 'as-is-where-is',  label: 'As-is, where-is' },
] as const

// Fallback display lists — used ONLY when public.property_types
// failed to load AND the operator opens step 1 before the lookup
// retries. The values here are display strings (NOT slugs) and will
// fail the FK on insert; they exist so the dropdown isn't empty in
// the load-failure window. The canonical source is `propertyTypes`
// fetched in loadLookups().
const BUILDING_TYPES_RESIDENTIAL_FALLBACK = [
  'Condominium', 'House and Lot', 'Townhouse', 'Apartment', 'Lot only',
] as const
const BUILDING_TYPES_COMMERCIAL_FALLBACK = [
  'Office', 'Retail', 'Warehouse', 'Industrial Lot', 'Mixed-use',
] as const

// Commercial-extras enums. Mirror the canonical values NewForm has used
// for years; the list is intentionally tight so reporting/filters stay
// useful. Free-form values land in the corresponding text input alongside.
const COMMERCIAL_BUILDING_CLASSES = ['Grade A', 'Grade B', 'Grade C', 'PEZA'] as const
const COMMERCIAL_AIRCON_TYPES = ['Centralized', 'Split Type', 'Window', 'VRF / VRV'] as const
const COMMERCIAL_AIRCON_OPS = ['24/7', 'Office hours', 'Office hours + extension'] as const
const COMMERCIAL_OFFICE_TYPES = ['Fitted', 'Bare shell', 'Warm shell'] as const
const COMMERCIAL_OFFICE_SETUPS = ['Open layout', 'Cubicles', 'Mixed', 'Executive', 'Call center ready'] as const

// Drop-down options. Each item carries `id` (the slug FK value the
// DB requires) and `display_name` (what the operator sees). When the
// lookup hasn't loaded yet (or failed), fall back to the display
// strings as both id + label — that lets the wizard render, but a
// submit before the lookup succeeds will fail the FK; the operator
// must wait for "Loading…" to clear.
const buildingTypeOptions = computed<Array<{ id: string; display_name: string; is_building: boolean }>>(() => {
  const live = propertyTypes.value.filter(
    (t) => t.property_category === form.value.category,
  )
  if (live.length > 0) {
    return live.map((t) => ({
      id: t.id,
      display_name: t.display_name || t.id,
      is_building: t.is_building,
    }))
  }
  const fallback =
    form.value.category === 'commercial'
      ? BUILDING_TYPES_COMMERCIAL_FALLBACK
      : BUILDING_TYPES_RESIDENTIAL_FALLBACK
  return fallback.map((label) => ({
    id: label,
    display_name: label,
    // Display-string fallback heuristic: assume the ones product
    // historically called "Condominium" / "Apartment" are buildings.
    // Once the live lookup loads, this is replaced by property_types.is_building.
    is_building: label === 'Condominium' || label === 'Apartment',
  }))
})

// Whether the location step should expose the Building selector. A
// detached house, a townhouse, a lot, or a freestanding warehouse
// don't belong to a "building" in the multi-unit sense — listing them
// against one would create misleading inventory under made-up tower
// names. Driven by property_types.is_building from the canonical
// table; falls back to slug-match heuristic when the lookup is loading.
const needsBuilding = computed(() => {
  const t = form.value.building_type
  if (!t) return false
  const live = propertyTypes.value.find((pt) => pt.id === t)
  if (live) return live.is_building
  // Lookup hasn't loaded yet — use the legacy heuristic so the UI
  // stays sensible during the brief load window.
  return t === 'Condominium' || t === 'Apartment' || t === 'condo' || t === 'apartment'
})

// Human-readable label for the currently-selected building_type slug.
// Used by the review step + inline helper text. Falls back to the
// raw value (which may be the slug if the lookup loaded, or the
// display string from the fallback list) so the UI never renders
// an empty cell unexpectedly.
const buildingTypeLabel = computed(() => {
  const t = form.value.building_type
  if (!t) return ''
  const live = propertyTypes.value.find((pt) => pt.id === t)
  return live?.display_name || t
})

// Slug → label for listing_condition. Mirrors the buildingTypeLabel
// pattern so the review step renders 'Bare shell' instead of the
// canonical 'bare-shell' slug.
const conditionLabel = computed(() => {
  const c = form.value.condition
  if (!c) return ''
  return CONDITION_OPTIONS.find((opt) => opt.value === c)?.label || c
})

// Helpers for the price block. PPS = price per sqm (recomputed
// reactively as the user types either side). Discount % shows the
// markdown when the operator filled in original_*_price > current
// price. NewForm wired these as auto-fillers on watch(); we render
// them as read-only helper text under the inputs so the broker sees
// the math without us silently overwriting their numbers.
function asNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const calcSalePps = computed(() => {
  const p = asNumber(form.value.sale_price)
  const a = asNumber(form.value.floor_area)
  return p > 0 && a > 0 ? Math.round(p / a) : 0
})
const calcRentPps = computed(() => {
  const p = asNumber(form.value.rent_price)
  const a = asNumber(form.value.floor_area)
  return p > 0 && a > 0 ? Math.round(p / a) : 0
})
const calcSaleDiscountPct = computed(() => {
  const cur = asNumber(form.value.sale_price)
  const orig = asNumber(form.value.original_sale_price)
  if (cur === 0 || orig === 0 || orig <= cur) return 0
  return Math.round(((orig - cur) / orig) * 100)
})
const calcRentDiscountPct = computed(() => {
  const cur = asNumber(form.value.rent_price)
  const orig = asNumber(form.value.original_rent_price)
  if (cur === 0 || orig === 0 || orig <= cur) return 0
  return Math.round(((orig - cur) / orig) * 100)
})

// Convert a (value, unit) pair to months. Lease terms are stored as
// smallint months on listings; the UI gives the broker a years
// shortcut so they don't have to multiply by 12 manually.
function toMonths(value: number, unit: LeaseUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return unit === 'years' ? Math.round(value * 12) : Math.round(value)
}

// Build the listings.attributes jsonb. Only includes keys with actual
// values so unused brokers' rows don't litter their listings with
// empty placeholders. Namespaced by feature group for forward-compat.
function buildAttributesPayload(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const commercial: Record<string, unknown> = {}
  if (form.value.category === 'commercial') {
    if (form.value.commercial_building_class)   commercial.building_class    = form.value.commercial_building_class
    if (form.value.commercial_aircon)            commercial.aircon            = form.value.commercial_aircon
    if (form.value.commercial_aircon_operation)  commercial.aircon_operation  = form.value.commercial_aircon_operation
    if (form.value.commercial_escalation !== '') commercial.escalation_pct    = Number(form.value.commercial_escalation) || null
    if (form.value.commercial_telcos)            commercial.telcos            = form.value.commercial_telcos
    if (form.value.commercial_office_floor)      commercial.office_floor      = form.value.commercial_office_floor
    if (form.value.commercial_office_type)       commercial.office_type       = form.value.commercial_office_type
    if (form.value.commercial_office_setup)      commercial.office_setup      = form.value.commercial_office_setup
    if (form.value.commercial_occupant_number !== '')
      commercial.occupant_number = Number(form.value.commercial_occupant_number) || null
  }
  if (Object.keys(commercial).length > 0) out.commercial = commercial

  const media: Record<string, unknown> = {}
  if (form.value.youtube_id)    media.youtube_id    = form.value.youtube_id.trim()
  if (form.value.slideshare_id) media.slideshare_id = form.value.slideshare_id.trim()
  if (Object.keys(media).length > 0) out.media = media

  return out
}

const filteredBarangays = computed(() => {
  if (!form.value.city_id) return [] as Barangay[]
  return barangays.value.filter((b) => b.city_id === form.value.city_id)
})

// =============================================================
// Lookup loaders. Each runs independently so a failure on one
// (e.g. RLS hiccup on contacts) doesn't block the others.
// =============================================================
async function loadLookups() {
  lookupsLoading.value = true
  await Promise.allSettled([
    (async () => {
      const { data } = await (supabase as any)
        .from('cities')
        .select('id, name')
        .order('name', { ascending: true })
      cities.value = (data ?? []) as City[]
    })(),
    (async () => {
      const { data } = await (supabase as any)
        .from('barangays')
        .select('id, name, city_id')
        .order('name', { ascending: true })
      barangays.value = (data ?? []) as Barangay[]
    })(),
    (async () => {
      try {
        const res = await $fetch<{ data: Building[] }>('/api/buildings', {
          params: { limit: 500 },
        })
        buildings.value = res?.data ?? []
      } catch {
        buildings.value = []
      }
    })(),
    (async () => {
      const { data } = await (supabase as any)
        .from('contacts')
        .select('id, full_name, email')
        .order('full_name', { ascending: true })
        .limit(500)
      contacts.value = (data ?? []) as Contact[]
    })(),
    (async () => {
      // amenities_usage is the catalog view NewForm has always used —
      // joins amenities + per-category usage counts so we can hide
      // amenities that have never been attached to (say) a commercial
      // listing. Order by name so the chip picker is alphabetical.
      const { data } = await (supabase as any)
        .from('amenities_usage')
        .select('amenity_id, amenity_name, residential_listings, commercial_listings')
        .order('amenity_name', { ascending: true })
      amenities.value = (data ?? []) as Amenity[]
    })(),
    (async () => {
      // Canonical property type catalog. listings.property_type AND
      // properties.type both FK to property_types.id (a VARCHAR(20)
      // slug, NOT the display name). Wizard binds dropdown :value
      // to id so inserts pass the FK.
      const { data } = await (supabase as any)
        .from('property_types')
        .select('id, display_name, property_category, is_building')
        .order('display_name', { ascending: true })
      propertyTypes.value = (data ?? []) as PropertyType[]
    })(),
  ])
  lookupsLoading.value = false
}

// Filter the catalog by chosen category. Until step 1 is filled the
// list is empty (the picker is on step 4 anyway). Residential = rows
// with residential_listings>0; commercial similarly. Mirrors NewForm.
const availableAmenities = computed<Amenity[]>(() => {
  const cat = form.value.category
  if (!cat) return []
  return amenities.value.filter((a) => {
    if (cat === 'residential') return (a.residential_listings ?? 0) > 0
    if (cat === 'commercial')  return (a.commercial_listings  ?? 0) > 0
    return true
  })
})

function toggleAmenity(id: number) {
  const i = selectedAmenities.value.indexOf(id)
  if (i === -1) selectedAmenities.value.push(id)
  else selectedAmenities.value.splice(i, 1)
}

const selectedAmenityNames = computed<string[]>(() => {
  if (selectedAmenities.value.length === 0) return []
  const map = new Map(amenities.value.map((a) => [a.amenity_id, a.amenity_name]))
  return selectedAmenities.value
    .map((id) => map.get(id))
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b))
})
onMounted(async () => {
  await loadLookups()
  if (isEdit.value) await hydrateFromListing(props.listingId as number)
})

// =============================================================
// Edit-mode hydration. Three parallel fetches:
//   1. The listing row itself (via _getListing → listing_details view)
//   2. The attributes jsonb (not on the view; pulled directly)
//   3. listing_amenities join rows → array of amenity_id
//   4. Existing displayed images via /api/listings/[id]/images/displayed
// On any failure we toast + leave the form pre-filled with whatever
// did arrive. Soft-fail; the operator can still navigate the wizard.
// =============================================================
async function hydrateFromListing(id: number) {
  loadingExisting.value = true
  try {
    const [listingRes, attrsRes, amenitiesRes, imagesRes] = await Promise.allSettled([
      ListingService._getListing(id),
      (supabase as any)
        .from('listings')
        .select('attributes')
        .eq('id', id)
        .maybeSingle(),
      (supabase as any)
        .from('listing_amenities')
        .select('amenity_id')
        .eq('listing_id', id),
      $fetch<Array<{ object: { Key?: string }; signedUrl: string }>>(
        `/api/listings/${id}/images/displayed`,
      ),
    ])

    if (listingRes.status === 'fulfilled' && listingRes.value?.data) {
      const d = listingRes.value.data as Record<string, any>
      // Map listing_details columns → wizard form. The view columns
      // are denormalized (city_id, barangay_id, contact_id are direct
      // FKs) so hydration is mostly direct copy.
      form.value.category = d.property_category ?? null
      form.value.for_sale = d.for_sale ? 1 : 0
      form.value.for_rent = d.for_rent ? 1 : 0
      form.value.building_type = d.property_type ?? ''
      form.value.title = d.title ?? ''
      form.value.description = d.description ?? ''
      form.value.status = d.status ?? 'available'
      form.value.availability_date = d.availability_date ?? ''
      form.value.contact_id = d.contact_id ?? null
      form.value.building_id = d.property_id ?? null
      form.value.developer_name = d.developer_name ?? ''
      form.value.year_built = d.year_built ?? null
      form.value.city_id = d.city_id ?? null
      form.value.barangay_id = d.barangay_id ?? null
      form.value.street_address = d.street_address ?? ''
      form.value.unit_number = d.unit_number ?? ''
      form.value.sale_price = d.sale_price ?? ''
      form.value.rent_price = d.rent_price ?? ''
      form.value.original_sale_price = d.original_sale_price ?? ''
      form.value.original_rent_price = d.original_rent_price ?? ''
      form.value.floor_area = d.floor_area ?? ''
      form.value.lot_area = d.lot_area ?? ''
      form.value.association_dues = d.association_dues ?? ''
      form.value.rent_advance = d.rent_advance ?? 1
      form.value.security_deposit = d.security_deposit ?? 2
      form.value.lease_term = d.lease_term ?? 12
      form.value.bedrooms = d.bedrooms ?? 0
      form.value.bathrooms = d.bathrooms ?? 0
      form.value.parking_spaces = d.parking_spaces ?? 0
      form.value.condition = d.condition ?? ''
      form.value.remarks = d.remarks ?? ''
    } else if (listingRes.status === 'rejected') {
      console.error('[wizard] hydrate listing failed', listingRes.reason)
      showToast({
        title: 'Could not load this listing — some fields may be blank.',
        icon: 'warning',
      })
    }

    // Attributes jsonb → flatten into commercial.* + media.* fields.
    if (attrsRes.status === 'fulfilled' && attrsRes.value?.data?.attributes) {
      const a = attrsRes.value.data.attributes as Record<string, any>
      const c = (a.commercial ?? {}) as Record<string, any>
      form.value.commercial_building_class   = c.building_class    ?? ''
      form.value.commercial_aircon            = c.aircon            ?? ''
      form.value.commercial_aircon_operation  = c.aircon_operation  ?? ''
      form.value.commercial_escalation        = c.escalation_pct    ?? ''
      form.value.commercial_telcos            = c.telcos            ?? ''
      form.value.commercial_office_floor      = c.office_floor      ?? ''
      form.value.commercial_office_type       = c.office_type       ?? ''
      form.value.commercial_office_setup      = c.office_setup      ?? ''
      form.value.commercial_occupant_number   = c.occupant_number   ?? ''
      const m = (a.media ?? {}) as Record<string, any>
      form.value.youtube_id    = m.youtube_id    ?? ''
      form.value.slideshare_id = m.slideshare_id ?? ''
    }

    if (amenitiesRes.status === 'fulfilled' && Array.isArray(amenitiesRes.value?.data)) {
      selectedAmenities.value = (amenitiesRes.value.data as Array<{ amenity_id: number }>)
        .map((r) => Number(r.amenity_id))
        .filter(Number.isFinite)
    }

    if (imagesRes.status === 'fulfilled' && Array.isArray(imagesRes.value)) {
      // Mark whichever image currently looks like the canonical
      // thumbnail (filename contains "thumbnail-") as isThumbnail
      // so the star renders pre-set in the UI.
      existingImages.value = (imagesRes.value as Array<{ object: { Key?: string }; signedUrl: string }>)
        .filter((r) => r.object?.Key && r.signedUrl)
        .map((r) => {
          const key = String(r.object.Key)
          const fname = key.split('/').pop() || ''
          return {
            key,
            signedUrl: r.signedUrl,
            isThumbnail: fname.includes('thumbnail-'),
            markedForDelete: false,
          }
        })
    }
  } finally {
    loadingExisting.value = false
  }
}

// User toggles existing-image actions. Marking-for-delete is a soft
// flag — actual S3 delete fires on submit. Re-clicking unmarks. The
// thumbnail star is a single-select across the existing-images set;
// new uploads keep their own thumbnail flag.
function toggleExistingDelete(key: string) {
  const img = existingImages.value.find((i) => i.key === key)
  if (img) img.markedForDelete = !img.markedForDelete
}
function setExistingThumbnail(key: string) {
  // Mutually exclusive: clear any other existing star, set this one,
  // and clear any new-upload thumbnail flag. The operator can pick
  // a thumbnail from EITHER set, not both.
  for (const img of existingImages.value) img.isThumbnail = img.key === key
  for (const img of form.value.images) img.thumbnail = false
  existingThumbnailNext.value = key
}

// =============================================================
// Validation. Required-field rules per step. Each rule returns a
// human-readable failure message or null. The Next button calls
// validateStep(step.value); Publish calls validateAll.
// =============================================================
function validateStep(s: StepId): string[] {
  const errs: string[] = []
  if (s === 1) {
    if (!form.value.category) errs.push('Property category (residential or commercial)')
    if (!form.value.for_sale && !form.value.for_rent) errs.push('Mark as for sale, for rent, or both')
    if (!form.value.building_type) errs.push('Building type')
    if (!form.value.title || form.value.title.trim().length < 5) errs.push('Listing title (at least 5 characters)')
    if (!form.value.availability_date) errs.push('Availability date')
    if (!form.value.contact_id) errs.push('Listing contact')
  }
  if (s === 2) {
    if (!form.value.city_id) errs.push('City')
    if (!form.value.barangay_id) errs.push('Barangay')
    if (!form.value.street_address) errs.push('Street address')
    // Building is only required for condos + apartments. Detached
    // houses, townhouses, lots, warehouses, etc. don't have one.
    if (needsBuilding.value && !form.value.building_id && !form.value.building_name_input) {
      errs.push('Building (pick existing or enter a new name)')
    }
  }
  if (s === 3) {
    if (form.value.for_sale === 1 && !form.value.sale_price) errs.push('Sale price (required for for-sale listings)')
    if (form.value.for_rent === 1 && !form.value.rent_price) errs.push('Rent price (required for for-rent listings)')
    if (!form.value.floor_area) errs.push('Floor area')
  }
  if (s === 4) {
    if (!form.value.condition) errs.push('Property condition')
  }
  if (s === 5) {
    // Photo step has no hard required fields — uploading zero is
    // allowed and downgrades the listing to a draft on publish.
  }
  return errs
}

function validateAll(): string[] {
  return [...validateStep(1), ...validateStep(2), ...validateStep(3), ...validateStep(4)]
}

async function nextStep() {
  const errs = validateStep(step.value)
  if (errs.length > 0) {
    stepErrors.value = errs
    showToast({
      title: `Missing ${errs.length} required field${errs.length === 1 ? '' : 's'} — fill them in to continue.`,
      icon: 'warning',
    })
    await nextTick()
    document.getElementById('wizard-step-banner')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  stepErrors.value = []
  if (step.value < 6) step.value = (step.value + 1) as StepId
}

function prevStep() {
  stepErrors.value = []
  if (step.value > 1) step.value = (step.value - 1) as StepId
}

function jumpTo(target: StepId) {
  // Backward jumps are always allowed. Forward jumps validate every
  // intermediate step so the user can't skip a required block.
  if (target <= step.value) {
    step.value = target
    stepErrors.value = []
    return
  }
  for (let s = step.value; s < target; s++) {
    const errs = validateStep(s as StepId)
    if (errs.length > 0) {
      stepErrors.value = errs
      step.value = s as StepId
      showToast({
        title: `Step ${s} has missing fields — fix them before jumping ahead.`,
        icon: 'warning',
      })
      return
    }
  }
  step.value = target
  stepErrors.value = []
}

// =============================================================
// Image handling. Files come in via <input type="file"> or drag-
// drop on the photo step. We store File + a data URL preview;
// reorder is array-position based; thumbnail is a single-flag
// designation across the array.
// =============================================================
const fileInputEl = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const isProcessing = ref(false)
const MAX_IMAGES = 12

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = (e) => resolve(String(e.target?.result ?? ''))
    r.onerror = (e) => reject(e)
    r.readAsDataURL(file)
  })
}

async function addFiles(fileList: FileList | File[]) {
  const incoming = Array.from(fileList).filter((f) => f.type.startsWith('image/'))
  const room = MAX_IMAGES - form.value.images.length
  if (incoming.length > room) {
    showToast({
      title: `Too many images — you can upload ${room} more (max ${MAX_IMAGES} total).`,
      icon: 'warning',
    })
  }
  const toAdd = incoming.slice(0, Math.max(0, room))
  if (toAdd.length === 0) return
  isProcessing.value = true
  const baseId = Date.now()
  for (let i = 0; i < toAdd.length; i++) {
    const f = toAdd[i] as File
    if (form.value.images.some((img) => img.name === f.name)) continue
    const dataUrl = await fileToDataUrl(f)
    const isFirstEver = form.value.images.length === 0
    form.value.images.push({
      id: baseId + i,
      name: f.name,
      file: f,
      dataUrl,
      thumbnail: isFirstEver,
    })
  }
  isProcessing.value = false
}

function onFileInputChange(ev: Event) {
  const t = ev.target as HTMLInputElement
  if (t.files) addFiles(t.files)
  t.value = ''
}

function onDrop(ev: DragEvent) {
  ev.preventDefault()
  isDragging.value = false
  if (ev.dataTransfer?.files) addFiles(ev.dataTransfer.files)
}

function setThumbnail(id: number) {
  for (const img of form.value.images) img.thumbnail = img.id === id
}

function removeImage(id: number) {
  const wasThumb = form.value.images.find((i) => i.id === id)?.thumbnail
  form.value.images = form.value.images.filter((i) => i.id !== id)
  // If we removed the thumbnail, promote the first remaining image.
  if (wasThumb && form.value.images.length > 0) {
    form.value.images[0]!.thumbnail = true
  }
}

function moveImage(id: number, dir: -1 | 1) {
  const idx = form.value.images.findIndex((i) => i.id === id)
  const next = idx + dir
  if (idx < 0 || next < 0 || next >= form.value.images.length) return
  const arr = form.value.images
  ;[arr[idx], arr[next]] = [arr[next] as WizardImage, arr[idx] as WizardImage]
}

const thumbnailImage = computed(() => form.value.images.find((i) => i.thumbnail) ?? null)

// Edit-mode helpers — drive the photo step's counts + the publish
// gates that previously assumed a brand-new listing.
const keptExistingImages = computed(() =>
  existingImages.value.filter((i) => !i.markedForDelete),
)
const pendingDeleteCount = computed(() =>
  existingImages.value.filter((i) => i.markedForDelete).length,
)
const keysToDelete = computed(() =>
  existingImages.value.filter((i) => i.markedForDelete).map((i) => i.key),
)
/** True when the post-save listing will have at least one photo —
 *  either a kept existing one or a new upload. Replaces the create-
 *  mode `form.value.images.length === 0` check. */
const willHavePhotos = computed(
  () => keptExistingImages.value.length > 0 || form.value.images.length > 0,
)
/** Human-readable thumbnail status for the photo-step header. */
const effectiveThumbnailLabel = computed(() => {
  if (thumbnailImage.value) return 'new cover set'
  const existingThumb = keptExistingImages.value.find((i) => i.isThumbnail)
  if (existingThumb) return 'cover preserved'
  return ''
})

// =============================================================
// Submit. Two paths:
//   - submit('publish') tries is_online=true. Drops to draft if
//     no images. Errors if images-but-no-thumbnail.
//   - submit('draft')   forces is_online=false. Skips thumbnail
//     check; images are optional.
// Both flows share the listing payload + the post-create amenity
// + image upload pipeline.
// =============================================================
async function submit(mode: 'publish' | 'draft') {
  if (isSaving.value) return
  const allErrs = validateAll()
  if (allErrs.length > 0) {
    stepErrors.value = allErrs
    showToast({
      title: 'Missing required fields — resolve the highlighted items before publishing.',
      icon: 'error',
    })
    return
  }

  // Publish-specific gates. In edit mode "willHavePhotos" accounts
  // for both kept existing photos AND new uploads, so a save that
  // doesn't add new photos but keeps existing ones still publishes.
  let effectivelyOnline = mode === 'publish'
  if (mode === 'publish' && !willHavePhotos.value) {
    effectivelyOnline = false
    showToast({
      title: 'Saved as draft — a listing needs at least one photo to publish. Add photos later from the listing page.',
      icon: 'warning',
    })
  }
  // Thumbnail required only when there ARE photos but none are
  // designated as cover (across both new + existing sets).
  const anyExistingThumbnail = keptExistingImages.value.some((i) => i.isThumbnail)
  if (
    mode === 'publish' &&
    willHavePhotos.value &&
    !thumbnailImage.value &&
    !anyExistingThumbnail
  ) {
    showToast({
      title: 'Pick a thumbnail — tap the star on one photo to designate the cover image, then publish.',
      icon: 'warning',
    })
    step.value = 5
    return
  }

  isSaving.value = true
  try {
    // 1. Resolve building → property_id. Only meaningful for condos
    //    and apartments — every other property type (house, townhouse,
    //    lot, warehouse, etc.) leaves property_id null even if the
    //    broker had typed a building name earlier and then changed
    //    the property type. This matches the step-2 UI that hides
    //    the selector outside needsBuilding.
    // Two distinct ids resolved here:
    //   propertyId — listings.property_id FK to properties(id) — the
    //                canonical real-estate entity from db-main-reference.
    //                Required for the listing INSERT.
    //   buildingId — listings.building_id FK to buildings(id) — a
    //                userportal-added first-class table from mig
    //                20260501000006. Optional. Different sequence from
    //                properties.id since the mig converted the legacy
    //                MV (which had id == property_id) into a real table
    //                with `bigint GENERATED ALWAYS AS IDENTITY`.
    //
    // Treating these two as the same value is the FK trap mig 011 left
    // behind — earlier wizard logic did `propertyId = form.value.
    // building_id` which only works for pre-mig-011 rows where the
    // two ids happen to overlap. New buildings rows fail
    // listings_building_id_fkey OR fk_listings_property depending on
    // which side is set.
    let propertyId: number | null = null
    let buildingId: number | null = null

    if (needsBuilding.value) {
      if (form.value.building_id) {
        // Existing building picked from the dropdown.
        // form.value.building_id is the buildings.id — use it for
        // listings.building_id. For the property side, look up a
        // properties row with the same id (pre-mig-011 overlap case).
        // If not found, fall back to creating a property using the
        // building's name + slug, leaving building_id pointed at the
        // existing buildings row so downstream features still link.
        buildingId = form.value.building_id
        const { data: existingProp } = await (supabase as any)
          .from('properties')
          .select('id')
          .eq('id', buildingId)
          .maybeSingle()
        if (existingProp?.id) {
          propertyId = existingProp.id as number
        } else {
          const bld = buildings.value.find((b) => b.id === buildingId)
          const { data: newProp, error: propErr } = await (supabase as any)
            .from('properties')
            .insert({
              name: bld?.building_name ?? form.value.building_name_input ?? 'Untitled building',
              category: form.value.category,
              type: form.value.building_type,
              street_address: form.value.street_address,
              city_id: form.value.city_id,
              barangay_id: form.value.barangay_id,
              created_by: user.value?.id ?? null,
              updated_by: user.value?.id ?? null,
            })
            .select('id')
            .single()
          if (propErr) throw new Error(`Could not create property: ${propErr.message}`)
          propertyId = newProp?.id ?? null
          // buildingId remains the buildings.id chosen from the dropdown.
        }
      } else if (form.value.building_name_input) {
        // Brand-new building name entered. Create a property row.
        // buildingId stays null — we don't auto-create a buildings
        // row from here; admin-side curation handles the buildings
        // catalog. listings.building_id ON DELETE SET NULL allows
        // null per mig 20260501000006.
        const { data: newProp, error: propErr } = await (supabase as any)
          .from('properties')
          .insert({
            name: form.value.building_name_input,
            category: form.value.category,
            type: form.value.building_type,
            street_address: form.value.street_address,
            city_id: form.value.city_id,
            barangay_id: form.value.barangay_id,
            created_by: user.value?.id ?? null,
            updated_by: user.value?.id ?? null,
          })
          .select('id')
          .single()
        if (propErr) throw new Error(`Could not create property: ${propErr.message}`)
        propertyId = newProp?.id ?? null
      }
    }

    // 2. Create the listing. Two classes of field are deliberately
    //    omitted from the payload:
    //      - Legacy denormalized names (city_name, barangay_name,
    //        contact_name, etc.) — assertNoLegacyFields throws on these.
    //      - listing_details MV-only fields (sale_price_per_sqm,
    //        rent_price_per_sqm) — computed by the MV from price +
    //        floor_area on refresh; writing them 400s with PGRST204.
    //        The refreshListingDetailsFromClient call inside the
    //        service repopulates them after every insert/update.
    //
    // Lease terms are persisted as MONTHS on the schema; the UI
    // toggle (months/years) is converted via toMonths().
    const attributes = buildAttributesPayload()

    const listingPayload: Record<string, unknown> = {
      property_id: propertyId,
      // building_id resolved separately from property_id — see the
      // dual-resolve block above for the rationale (mig 20260501000006
      // diverged the buildings sequence from properties.id).
      building_id: buildingId,
      property_category: form.value.category,
      property_type: form.value.building_type,
      contact_id: form.value.contact_id,
      city_id: form.value.city_id,
      barangay_id: form.value.barangay_id,
      title: form.value.title,
      description: form.value.description?.trim() || null,
      status: form.value.status,
      condition: form.value.condition,
      unit_number: form.value.unit_number,
      developer_name: form.value.developer_name?.trim() || null,
      year_built: form.value.year_built ? Number(form.value.year_built) || null : null,
      is_online: effectivelyOnline,
      for_sale: form.value.for_sale,
      for_rent: form.value.for_rent,
      sale_price: form.value.for_sale ? Number(form.value.sale_price) || null : null,
      rent_price: form.value.for_rent ? Number(form.value.rent_price) || null : null,
      original_sale_price: form.value.for_sale && form.value.original_sale_price
        ? Number(form.value.original_sale_price) || null
        : null,
      original_rent_price: form.value.for_rent && form.value.original_rent_price
        ? Number(form.value.original_rent_price) || null
        : null,
      bedrooms: Number(form.value.bedrooms) || 0,
      bathrooms: Number(form.value.bathrooms) || 0,
      floor_area: Number(form.value.floor_area) || null,
      lot_area: Number(form.value.lot_area) || null,
      parking_spaces: Number(form.value.parking_spaces) || 0,
      lease_term: form.value.for_rent
        ? toMonths(Number(form.value.lease_term), form.value.lease_term_unit) || null
        : null,
      rent_advance: form.value.for_rent
        ? toMonths(Number(form.value.rent_advance), form.value.rent_advance_unit) || null
        : null,
      security_deposit: form.value.for_rent
        ? toMonths(Number(form.value.security_deposit), form.value.security_deposit_unit) || null
        : null,
      association_dues: Number(form.value.association_dues) || null,
      availability_date: form.value.availability_date,
      remarks: form.value.remarks,
      // Only attach attributes when we actually have something to write
      // — otherwise an empty {} would still trigger an update vs. the
      // column default for no benefit.
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    }

    // Branch: edit mode UPDATEs the existing row, create mode INSERTs
    // a new one. Both produce the same `listingId` for the downstream
    // amenity + image work. Audit log is automatic — the
    // listings_audit_diff trigger (mig 20260507000007) writes a
    // listing.updated activity row with field-level changes for every
    // edit. ListingHistoryDrawer renders that without extra plumbing.
    let listingId: number
    if (isEdit.value) {
      const updated = await ListingService._updateListing(
        props.listingId as number,
        listingPayload,
      )
      const idFromRow = (updated as any)?.id
      listingId = Number(idFromRow ?? props.listingId)
      if (!Number.isFinite(listingId)) {
        throw new Error('Listing update returned no id.')
      }
    } else {
      const { data: created } = await ListingService._createListingOnly(
        listingPayload,
        user.value?.id ?? null,
      )
      const idFromRow = (created as any)?.id
      if (!idFromRow) throw new Error('Listing was created but no id was returned.')
      listingId = Number(idFromRow)
    }

    // 2a. Persist selected amenities. Parallel inserts into the join
    //     table — same shape NewForm has used for years. In edit mode
    //     we replace the full set (delete-all + insert-current) so the
    //     UI's "selected" reflects ground truth post-save.
    if (isEdit.value) {
      const { error: amenWipeErr } = await (supabase as any)
        .from('listing_amenities')
        .delete()
        .eq('listing_id', listingId)
      if (amenWipeErr) {
        console.warn('[wizard] amenity wipe failed', amenWipeErr)
      }
    }
    if (selectedAmenities.value.length > 0) {
      const amenityRows = selectedAmenities.value.map((amenity_id) => ({
        listing_id: listingId,
        amenity_id,
      }))
      const { error: amenErr } = await (supabase as any)
        .from('listing_amenities')
        .insert(amenityRows)
      if (amenErr) {
        console.error('[wizard] amenity insert failed', amenErr)
        showToast({
          title: 'Listing saved, but amenities did not attach. Re-pick them on the listing page.',
          icon: 'warning',
        })
      }
    }

    // 3. Image mutations — edit mode goes deletes-first, then
    //    uploads, then thumbnail update for an existing-image
    //    selection. Create mode skips the deletes branch entirely.
    if (isEdit.value && keysToDelete.value.length > 0) {
      try {
        await $fetch(`/api/listings/${listingId}/images/delete-by-keys`, {
          method: 'POST',
          body: { keys: keysToDelete.value },
        })
      } catch (delErr: any) {
        console.error('[wizard] image delete failed', delErr)
        showToast({
          title: 'Some photos could not be deleted. They may still appear on the listing.',
          icon: 'warning',
        })
      }
    }

    // Image upload — AWAITED so the user doesn't land on the detail
    // page before S3 has the files. Previously fire-and-forget
    // (.catch-chained), which manifested as "No photos available"
    // when the listing page raced ahead of the uploads. The thumbnail
    // pass downstream of upload may still 404 (separate id-mapping
    // bug between Date.now()-based WizardImage.id and the S3
    // globalIndex used in filenames); that's wrapped in its own
    // try/catch inside _uploadListingImages, so a thumbnail miss
    // doesn't fail the gallery — files still land in S3 and
    // get-gallery-images sees them.
    let imageUploadWarning = false
    const thumbId = thumbnailImage.value?.id ?? null
    if (form.value.images.length > 0) {
      const payloadImages = form.value.images.map((i) => ({
        id: i.id,
        name: i.name,
        file: i.file,
        dataUrl: i.dataUrl,
        thumbnail: i.thumbnail,
        extension: i.name.split('.').pop() ?? 'jpg',
      }))
      // originalImages and images use the same payload — no
      // watermark step in the wizard.
      // The listing service's TS signature on _uploadListingImages
      // currently types the thumbnailId param as null-only; the
      // runtime code accepts a number. Cast through `as any` so the
      // wizard can pass the picked id without lying about the
      // contract everywhere else. Cleanup PR can widen the service
      // type when other callers can absorb it.
      try {
        await (ListingService._uploadListingImages as any)(
          listingId, payloadImages, payloadImages, thumbId,
        )
      } catch (err: any) {
        console.error('[wizard] image upload failed', err)
        imageUploadWarning = true
        showToast({
          title: 'Image upload issue — some photos may not have uploaded. Open the listing to retry.',
          icon: 'warning',
        })
      }
    }

    // Edit-mode thumbnail handoff: when the operator picked an
    // EXISTING image as the new cover (no new upload chosen), set
    // the thumbnail server-side directly. Skipped when a new upload
    // is the cover (the upload pipeline above handled it).
    if (isEdit.value && existingThumbnailNext.value && !thumbnailImage.value) {
      try {
        await $fetch('/api/listings/update-thumbnail', {
          method: 'POST',
          body: { listingId, key: existingThumbnailNext.value },
        })
      } catch (thumbErr: any) {
        console.warn('[wizard] thumbnail update failed', thumbErr)
        // Non-fatal; the listing still saved. Operator can re-pick
        // a thumbnail from the listing page.
      }
    }

    // Phrasing reflects what actually happened. With the awaited
    // upload above, photos are in S3 by the time we navigate.
    const photoSuffix = form.value.images.length > 0
      ? imageUploadWarning
        ? ' (photo upload had issues — open the listing to retry)'
        : ` with ${form.value.images.length} photo${form.value.images.length === 1 ? '' : 's'}`
      : ''
    showToast({
      title: isEdit.value
        ? `Listing #${listingId} saved${photoSuffix}.`
        : effectivelyOnline
        ? `Listing #${listingId} published${photoSuffix}.`
        : `Listing #${listingId} saved as draft${photoSuffix}.`,
      icon: 'success',
    })
    router.push(`/listings/${listingId}`)
  } catch (err: any) {
    console.error('[wizard] submit failed', err)
    showToast({
      title: isEdit.value
        ? `Could not save listing — ${err?.message || 'unexpected error.'}`
        : `Could not create listing — ${err?.message || 'unexpected error.'}`,
      icon: 'error',
    })
  } finally {
    isSaving.value = false
  }
}

const STEPS: Array<{ id: StepId; label: string; description: string }> = [
  { id: 1, label: 'Basics',   description: 'Type, title, contact' },
  { id: 2, label: 'Location', description: 'Building & address' },
  { id: 3, label: 'Pricing',  description: 'Price & terms' },
  { id: 4, label: 'Details',  description: 'Beds, baths, condition' },
  { id: 5, label: 'Photos & media', description: 'Photos, video, embeds' },
  { id: 6, label: 'Review',   description: 'Confirm & publish' },
]
</script>

<template>
  <div class="space-y-6">
    <!-- Stepper -->
    <ol class="flex flex-wrap items-stretch gap-2 rounded-xl border border-border bg-card p-2 sm:gap-3 sm:p-3">
      <li
        v-for="s in STEPS"
        :key="s.id"
        class="flex flex-1 min-w-[120px]"
      >
        <button
          type="button"
          class="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all duration-150 ease-out focus-ring"
          :class="[
            step === s.id
              ? 'bg-primary/10 ring-1 ring-primary/30'
              : (s.id < step ? 'bg-muted/50 hover:bg-accent' : 'hover:bg-accent'),
          ]"
          @click="jumpTo(s.id)"
        >
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums"
            :class="[
              step === s.id
                ? 'bg-primary text-primary-foreground'
                : (s.id < step ? 'bg-success text-success-foreground' : 'bg-muted text-muted-foreground'),
            ]"
          >
            <span v-if="s.id < step" aria-hidden="true">✓</span>
            <span v-else>{{ s.id }}</span>
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs font-semibold text-foreground">{{ s.label }}</span>
            <span class="block truncate text-[11px] text-muted-foreground">{{ s.description }}</span>
          </span>
        </button>
      </li>
    </ol>

    <!-- Step error banner -->
    <div
      v-if="stepErrors.length > 0"
      id="wizard-step-banner"
      class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      <p class="font-semibold">{{ stepErrors.length }} field{{ stepErrors.length === 1 ? '' : 's' }} need attention before you continue.</p>
      <ul class="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px]">
        <li v-for="(err, idx) in stepErrors" :key="idx">{{ err }}</li>
      </ul>
    </div>

    <UiCard padding="md">
      <!-- ============================================================ -->
      <!-- STEP 1 — BASICS                                                -->
      <!-- ============================================================ -->
      <div v-if="step === 1" class="space-y-5">
        <h3 class="text-lg font-bold text-foreground">Basics</h3>

        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Property category <span class="text-destructive">*</span></span>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="cat in (['residential', 'commercial'] as const)"
                :key="cat"
                type="button"
                class="rounded-lg border px-3 py-2 text-sm font-semibold capitalize transition-colors duration-150 ease-out focus-ring"
                :class="form.category === cat
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card hover:bg-accent'"
                @click="form.category = cat; form.building_type = ''"
              >
                {{ cat }}
              </button>
            </div>
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Available for <span class="text-destructive">*</span></span>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="rounded-lg border px-3 py-2 text-sm font-semibold transition-colors duration-150 ease-out focus-ring"
                :class="form.for_rent === 1
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card hover:bg-accent'"
                @click="form.for_rent = form.for_rent === 1 ? 0 : 1"
              >
                For rent
              </button>
              <button
                type="button"
                class="rounded-lg border px-3 py-2 text-sm font-semibold transition-colors duration-150 ease-out focus-ring"
                :class="form.for_sale === 1
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card hover:bg-accent'"
                @click="form.for_sale = form.for_sale === 1 ? 0 : 1"
              >
                For sale
              </button>
            </div>
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-sm font-semibold text-foreground">Building type <span class="text-destructive">*</span></span>
          <select
            v-model="form.building_type"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
          >
            <option value="" disabled>
              {{ lookupsLoading ? 'Loading building types…' : 'Select a building type…' }}
            </option>
            <option v-for="t in buildingTypeOptions" :key="t.id" :value="t.id">{{ t.display_name }}</option>
          </select>
          <span v-if="!form.category" class="mt-1 block text-[11px] text-muted-foreground">
            Pick a property category first.
          </span>
        </label>

        <label class="block">
          <span class="mb-1 block text-sm font-semibold text-foreground">Title <span class="text-destructive">*</span></span>
          <input
            v-model="form.title"
            type="text"
            placeholder="e.g. 2BR condo with parking, BGC"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            maxlength="200"
          />
          <span class="mt-1 block text-[11px] text-muted-foreground">
            {{ form.title.length }}/200 characters · used as the listing's display name across the platform.
          </span>
        </label>

        <!-- Public-facing description. Shown on the website's property
             page + included in syndication feeds. Restored from NewForm. -->
        <label class="block">
          <span class="mb-1 block text-sm font-semibold text-foreground">Description</span>
          <textarea
            v-model="form.description"
            rows="5"
            placeholder="Describe the unit, the building, and the location. Buyers read this when shortlisting — be concrete (views, amenities, transit, recent renovations)."
            maxlength="4000"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
          />
          <span class="mt-1 block text-[11px] text-muted-foreground">
            {{ form.description.length }}/4000 characters · markdown not rendered, line breaks are preserved.
          </span>
        </label>

        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Status</span>
            <select
              v-model="form.status"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            >
              <option v-for="s in STATUS_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Available from <span class="text-destructive">*</span></span>
            <input
              v-model="form.availability_date"
              type="date"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-sm font-semibold text-foreground">Listing contact <span class="text-destructive">*</span></span>
          <select
            v-model.number="form.contact_id"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
          >
            <option :value="null" disabled>{{ lookupsLoading ? 'Loading contacts…' : 'Select a contact…' }}</option>
            <option v-for="c in contacts" :key="c.id" :value="c.id">
              {{ c.full_name }}{{ c.email ? ` · ${c.email}` : '' }}
            </option>
          </select>
          <span class="mt-1 block text-[11px] text-muted-foreground">
            The owner / agent point of contact for this listing.
            <NuxtLink to="/contacts" class="text-primary hover:underline">Manage contacts →</NuxtLink>
          </span>
        </label>
      </div>

      <!-- ============================================================ -->
      <!-- STEP 2 — LOCATION                                              -->
      <!-- ============================================================ -->
      <div v-else-if="step === 2" class="space-y-5">
        <h3 class="text-lg font-bold text-foreground">Location</h3>

        <!-- Building selector — only meaningful for multi-unit
             property types (condos + apartments). Hidden + skipped by
             validation for houses, townhouses, lots, and freestanding
             commercial spaces. The values persist if the broker
             toggles building_type back to condo/apt later. -->
        <div v-if="needsBuilding">
          <span class="mb-1 block text-sm font-semibold text-foreground">
            Building <span class="text-destructive">*</span>
          </span>
          <select
            v-model.number="form.building_id"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            @change="form.building_name_input = ''"
          >
            <option :value="null">{{ lookupsLoading ? 'Loading buildings…' : 'Pick existing or enter new below' }}</option>
            <option v-for="b in buildings" :key="b.id" :value="b.id">{{ b.building_name }}</option>
          </select>
          <input
            v-if="!form.building_id"
            v-model="form.building_name_input"
            type="text"
            placeholder="Or enter a new building name"
            class="mt-2 w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
          />
          <span class="mt-1 block text-[11px] text-muted-foreground">
            Pick from the existing list or enter a new name.
            {{ buildingTypeLabel ? `Required for ${buildingTypeLabel.toLowerCase()} listings.` : '' }}
          </span>
        </div>
        <div
          v-else-if="form.building_type"
          class="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground"
        >
          Building selection is only used for condos and apartments — skipped for {{ buildingTypeLabel.toLowerCase() }} listings.
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">City <span class="text-destructive">*</span></span>
            <select
              v-model.number="form.city_id"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              @change="form.barangay_id = null"
            >
              <option :value="null" disabled>{{ lookupsLoading ? 'Loading cities…' : 'Select a city…' }}</option>
              <option v-for="c in cities" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Barangay <span class="text-destructive">*</span></span>
            <select
              v-model.number="form.barangay_id"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              :disabled="!form.city_id"
            >
              <option :value="null" disabled>
                {{ form.city_id ? 'Select a barangay…' : 'Pick a city first' }}
              </option>
              <option v-for="b in filteredBarangays" :key="b.id" :value="b.id">{{ b.name }}</option>
            </select>
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-sm font-semibold text-foreground">Street address <span class="text-destructive">*</span></span>
          <input
            v-model="form.street_address"
            type="text"
            placeholder="e.g. 32 Bonifacio Drive"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
          />
        </label>

        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Unit number</span>
            <input
              v-model="form.unit_number"
              type="text"
              placeholder="e.g. 12-B"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
          </label>

          <label v-if="!form.building_id" class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Property owner / developer</span>
            <input
              v-model="form.property_owner"
              type="text"
              placeholder="Optional"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
          </label>
        </div>

        <!-- Building metadata. Surfaced on the website's property page
             and used by branded-residence detection / age-of-stock
             filters. Both optional but high-signal when set. -->
        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Developer / operator</span>
            <input
              v-model="form.developer_name"
              type="text"
              placeholder="e.g. Ayala Land, Megaworld, Aman"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
            <span class="mt-1 block text-[11px] text-muted-foreground">
              Used by the website's branded-residence detection (Aman, Ritz-Carlton, …).
            </span>
          </label>
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Year built</span>
            <input
              v-model.number="form.year_built"
              type="number"
              min="1900"
              :max="new Date().getFullYear() + 5"
              placeholder="e.g. 2018"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
          </label>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- STEP 3 — PRICING                                               -->
      <!-- ============================================================ -->
      <div v-else-if="step === 3" class="space-y-5">
        <h3 class="text-lg font-bold text-foreground">Pricing</h3>

        <div class="grid gap-4 md:grid-cols-2">
          <label v-if="form.for_rent === 1" class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Rent price (monthly, PHP) <span class="text-destructive">*</span></span>
            <input
              v-model="form.rent_price"
              type="number"
              min="0"
              step="100"
              placeholder="35000"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
            <span v-if="calcRentPps > 0" class="mt-1 block text-[11px] text-muted-foreground">
              ≈ <strong class="text-foreground">₱{{ calcRentPps.toLocaleString() }}</strong> / sqm based on the floor area below.
            </span>
          </label>
          <label v-if="form.for_sale === 1" class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Sale price (PHP) <span class="text-destructive">*</span></span>
            <input
              v-model="form.sale_price"
              type="number"
              min="0"
              step="1000"
              placeholder="8500000"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
            <span v-if="calcSalePps > 0" class="mt-1 block text-[11px] text-muted-foreground">
              ≈ <strong class="text-foreground">₱{{ calcSalePps.toLocaleString() }}</strong> / sqm based on the floor area below.
            </span>
          </label>
        </div>

        <!-- Original/reduced price block. Optional. When set above the
             current price, the website renders a "Reduced from ₱X" tag
             and the discount % shows as a chip. Persisted to
             listings.original_sale_price / original_rent_price. -->
        <details class="rounded-lg border border-border bg-muted/20 px-4 py-3">
          <summary class="cursor-pointer text-sm font-semibold text-foreground">
            Original (pre-discount) price · optional
          </summary>
          <p class="mt-2 text-[11px] text-muted-foreground">
            Set the price the listing was originally posted at. The website renders a "Reduced from ₱X — −Y%" tag on the card when this is higher than the current price.
          </p>
          <div class="mt-3 grid gap-4 md:grid-cols-2">
            <label v-if="form.for_rent === 1" class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Original rent (PHP / month)</span>
              <input
                v-model="form.original_rent_price"
                type="number"
                min="0"
                step="100"
                placeholder="e.g. 40000"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              />
              <span v-if="calcRentDiscountPct > 0" class="mt-1 block text-[11px] font-semibold text-success">
                ↓ {{ calcRentDiscountPct }}% discount surfaced on listing card.
              </span>
            </label>
            <label v-if="form.for_sale === 1" class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Original sale price (PHP)</span>
              <input
                v-model="form.original_sale_price"
                type="number"
                min="0"
                step="1000"
                placeholder="e.g. 9500000"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              />
              <span v-if="calcSaleDiscountPct > 0" class="mt-1 block text-[11px] font-semibold text-success">
                ↓ {{ calcSaleDiscountPct }}% discount surfaced on listing card.
              </span>
            </label>
          </div>
        </details>

        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Floor area (sqm) <span class="text-destructive">*</span></span>
            <input
              v-model="form.floor_area"
              type="number"
              min="0"
              step="0.1"
              placeholder="65"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Lot area (sqm)</span>
            <input
              v-model="form.lot_area"
              type="number"
              min="0"
              step="0.1"
              placeholder="Optional for condos / units"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
          </label>
        </div>

        <!-- Rental terms block — adds a months/years toggle next to
             every duration field. Submit converts to months. -->
        <div v-if="form.for_rent === 1" class="rounded-lg border border-border bg-muted/30 p-4">
          <p class="mb-3 text-sm font-semibold text-foreground">Rental terms</p>
          <div class="grid gap-3 md:grid-cols-3">
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Minimum lease term</span>
              <div class="flex gap-1">
                <input
                  v-model.number="form.lease_term"
                  type="number"
                  min="1"
                  class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
                />
                <select
                  v-model="form.lease_term_unit"
                  class="rounded-md border border-border bg-card px-2 py-2 text-xs focus-ring"
                >
                  <option value="months">mo</option>
                  <option value="years">yr</option>
                </select>
              </div>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Advance payment</span>
              <div class="flex gap-1">
                <input
                  v-model.number="form.rent_advance"
                  type="number"
                  min="0"
                  class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
                />
                <select
                  v-model="form.rent_advance_unit"
                  class="rounded-md border border-border bg-card px-2 py-2 text-xs focus-ring"
                >
                  <option value="months">mo</option>
                  <option value="years">yr</option>
                </select>
              </div>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Security deposit</span>
              <div class="flex gap-1">
                <input
                  v-model.number="form.security_deposit"
                  type="number"
                  min="0"
                  class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
                />
                <select
                  v-model="form.security_deposit_unit"
                  class="rounded-md border border-border bg-card px-2 py-2 text-xs focus-ring"
                >
                  <option value="months">mo</option>
                  <option value="years">yr</option>
                </select>
              </div>
            </label>
          </div>
        </div>

        <label class="block">
          <span class="mb-1 block text-sm font-semibold text-foreground">Association dues (PHP, optional)</span>
          <input
            v-model="form.association_dues"
            type="number"
            min="0"
            placeholder="e.g. 6500"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
          />
        </label>
      </div>

      <!-- ============================================================ -->
      <!-- STEP 4 — DETAILS                                               -->
      <!-- ============================================================ -->
      <div v-else-if="step === 4" class="space-y-5">
        <h3 class="text-lg font-bold text-foreground">Details</h3>

        <div class="grid gap-4 sm:grid-cols-3">
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Bedrooms</span>
            <input v-model.number="form.bedrooms" type="number" min="0" class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring" />
          </label>
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Bathrooms</span>
            <input v-model.number="form.bathrooms" type="number" min="0" class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring" />
          </label>
          <label class="block">
            <span class="mb-1 block text-sm font-semibold text-foreground">Parking spaces</span>
            <input v-model.number="form.parking_spaces" type="number" min="0" class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring" />
          </label>
        </div>

        <div>
          <span class="mb-2 block text-sm font-semibold text-foreground">Condition <span class="text-destructive">*</span></span>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in CONDITION_OPTIONS"
              :key="c.value"
              type="button"
              class="rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-150 ease-out focus-ring"
              :class="form.condition === c.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card hover:bg-accent'"
              @click="form.condition = c.value"
            >
              {{ c.label }}
            </button>
          </div>
        </div>

        <!-- Amenities. Chip picker, multi-select. The catalog comes
             from amenities_usage (filtered by category) so brokers
             only see amenities relevant to residential vs. commercial.
             Non-required: a listing can publish with zero amenities. -->
        <div>
          <div class="mb-2 flex items-end justify-between">
            <span class="block text-sm font-semibold text-foreground">
              Amenities
              <span class="ml-1 text-[11px] font-normal text-muted-foreground">
                (optional · {{ selectedAmenities.length }} selected)
              </span>
            </span>
            <button
              v-if="selectedAmenities.length > 0"
              type="button"
              class="text-[11px] font-medium text-muted-foreground hover:text-foreground focus-ring rounded"
              @click="selectedAmenities = []"
            >
              Clear all
            </button>
          </div>
          <p
            v-if="lookupsLoading && availableAmenities.length === 0"
            class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-center text-xs text-muted-foreground"
          >
            Loading amenities…
          </p>
          <p
            v-else-if="!form.category"
            class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-center text-xs text-muted-foreground"
          >
            Pick a category in step 1 to see relevant amenities.
          </p>
          <p
            v-else-if="availableAmenities.length === 0"
            class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-center text-xs text-muted-foreground"
          >
            No amenities catalogued for this category yet.
          </p>
          <div v-else class="flex flex-wrap gap-2">
            <button
              v-for="a in availableAmenities"
              :key="a.amenity_id"
              type="button"
              class="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out focus-ring"
              :class="selectedAmenities.includes(a.amenity_id)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card hover:bg-accent'"
              @click="toggleAmenity(a.amenity_id)"
            >
              {{ a.amenity_name }}
            </button>
          </div>
        </div>

        <!-- Commercial-specific extras. Only rendered when category=commercial.
             All optional. Persisted into listings.attributes.commercial.* — see
             buildAttributesPayload(). Same field set NewForm has carried for
             years; the values flow to the website's commercial-listing surface. -->
        <div v-if="form.category === 'commercial'" class="rounded-lg border border-border bg-muted/20 p-4">
          <p class="mb-3 text-sm font-semibold text-foreground">
            Commercial details <span class="ml-1 text-[11px] font-normal text-muted-foreground">(all optional)</span>
          </p>

          <div class="grid gap-4 md:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Building class</span>
              <select
                v-model="form.commercial_building_class"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              >
                <option value="">—</option>
                <option v-for="c in COMMERCIAL_BUILDING_CLASSES" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Office floor</span>
              <input
                v-model="form.commercial_office_floor"
                type="text"
                placeholder="e.g. 12th floor / Penthouse"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              />
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Aircon type</span>
              <select
                v-model="form.commercial_aircon"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              >
                <option value="">—</option>
                <option v-for="c in COMMERCIAL_AIRCON_TYPES" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Aircon operation</span>
              <select
                v-model="form.commercial_aircon_operation"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              >
                <option value="">—</option>
                <option v-for="c in COMMERCIAL_AIRCON_OPS" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Office type</span>
              <select
                v-model="form.commercial_office_type"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              >
                <option value="">—</option>
                <option v-for="c in COMMERCIAL_OFFICE_TYPES" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Office setup</span>
              <select
                v-model="form.commercial_office_setup"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              >
                <option value="">—</option>
                <option v-for="c in COMMERCIAL_OFFICE_SETUPS" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Annual escalation (%)</span>
              <input
                v-model="form.commercial_escalation"
                type="number"
                min="0"
                step="0.1"
                placeholder="e.g. 5"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              />
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">Recommended occupant count</span>
              <input
                v-model="form.commercial_occupant_number"
                type="number"
                min="0"
                placeholder="e.g. 30"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              />
            </label>
          </div>

          <label class="mt-4 block">
            <span class="mb-1 block text-xs font-semibold text-muted-foreground">Telco providers available</span>
            <input
              v-model="form.commercial_telcos"
              type="text"
              placeholder="e.g. PLDT, Globe, Converge"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
            />
          </label>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- STEP 5 — PHOTOS & MEDIA                                        -->
      <!-- ============================================================ -->
      <div v-else-if="step === 5" class="space-y-5">
        <div class="flex items-baseline justify-between">
          <h3 class="text-lg font-bold text-foreground">Photos &amp; media</h3>
          <p class="text-xs text-muted-foreground">
            <template v-if="isEdit">
              {{ keptExistingImages.length }} existing
              <span v-if="form.images.length > 0">· {{ form.images.length }} new</span>
              <span v-if="effectiveThumbnailLabel" class="ml-2 text-success">· {{ effectiveThumbnailLabel }}</span>
            </template>
            <template v-else>
              {{ form.images.length }} / {{ MAX_IMAGES }} uploaded
              <span v-if="thumbnailImage" class="ml-2 text-success">· thumbnail set</span>
            </template>
          </p>
        </div>

        <!-- Existing-photo grid (edit mode only). Each tile has a
             star (set as thumbnail) + remove (queue for delete on
             save). Marked-for-delete tiles fade and show a bright
             "Will delete" overlay. Operator can undo before saving. -->
        <div v-if="isEdit && existingImages.length > 0">
          <p class="mb-2 text-sm font-semibold text-foreground">
            Already on this listing
            <span class="ml-1 text-[11px] font-normal text-muted-foreground">
              ({{ existingImages.length }} total · {{ pendingDeleteCount }} marked to delete)
            </span>
          </p>
          <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            <div
              v-for="img in existingImages"
              :key="img.key"
              class="group relative overflow-hidden rounded-lg border border-border bg-card shadow-sm"
              :class="[
                img.markedForDelete ? 'opacity-50 ring-2 ring-destructive/60' : '',
                img.isThumbnail && !img.markedForDelete ? 'ring-2 ring-primary' : '',
              ]"
            >
              <img
                :src="img.signedUrl"
                :alt="img.key.split('/').pop() ?? 'Listing photo'"
                class="aspect-[4/3] w-full object-cover"
                loading="lazy"
              />
              <div
                v-if="img.markedForDelete"
                class="absolute inset-0 flex items-center justify-center bg-destructive/70 text-xs font-bold uppercase tracking-wide text-destructive-foreground"
              >
                Will delete on save
              </div>
              <div class="absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-1.5">
                <UiBadge
                  v-if="img.isThumbnail && !img.markedForDelete"
                  variant="primary"
                  size="xs"
                  class="shadow-sm"
                >
                  ★ Cover
                </UiBadge>
                <span v-else />
                <button
                  type="button"
                  class="rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-semibold shadow-sm focus-ring"
                  :class="img.markedForDelete ? 'text-foreground' : 'text-destructive'"
                  @click="toggleExistingDelete(img.key)"
                >
                  {{ img.markedForDelete ? 'Undo delete' : '✕ Delete' }}
                </button>
              </div>
              <div class="flex items-center justify-center border-t border-border bg-card px-2 py-1.5">
                <button
                  type="button"
                  class="rounded px-1 text-[11px] font-semibold transition-colors duration-150 ease-out focus-ring"
                  :class="img.isThumbnail
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'"
                  :disabled="img.markedForDelete"
                  @click="setExistingThumbnail(img.key)"
                >
                  {{ img.isThumbnail ? '★ Cover' : '☆ Set as cover' }}
                </button>
              </div>
            </div>
          </div>
          <p
            v-if="form.images.length > 0 || existingImages.length > 0"
            class="mt-3 text-[11px] text-muted-foreground"
          >
            Add more below — or just save to keep the existing set.
          </p>
        </div>

        <p class="rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          Photos are optional — but a listing without a photo will be saved as a <strong class="text-foreground">draft</strong>.
          To publish, upload at least one photo and tap the <span aria-hidden="true">★</span> star to designate the cover thumbnail.
        </p>

        <!-- Drop zone -->
        <div
          class="relative flex min-h-[140px] flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors duration-150 ease-out"
          :class="isDragging
            ? 'border-primary bg-primary/5'
            : 'border-border bg-muted/20 hover:bg-muted/30'"
          @dragenter.prevent="isDragging = true"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop="onDrop"
        >
          <p class="text-sm font-semibold text-foreground">Drop photos here or</p>
          <button
            type="button"
            class="mt-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring"
            @click="fileInputEl?.click()"
          >
            Browse files
          </button>
          <input
            ref="fileInputEl"
            type="file"
            accept="image/*"
            multiple
            class="hidden"
            @change="onFileInputChange"
          />
          <p class="mt-2 text-[11px] text-muted-foreground">JPEG / PNG / WebP · up to {{ MAX_IMAGES }} photos</p>
          <div
            v-if="isProcessing"
            class="absolute inset-0 flex items-center justify-center rounded-xl bg-card/70 text-xs text-muted-foreground backdrop-blur-sm"
          >
            Processing photos…
          </div>
        </div>

        <!-- Image grid -->
        <div
          v-if="form.images.length > 0"
          class="grid gap-3 sm:grid-cols-2 md:grid-cols-3"
        >
          <div
            v-for="(img, idx) in form.images"
            :key="img.id"
            class="group relative overflow-hidden rounded-lg border border-border bg-card shadow-sm"
            :class="img.thumbnail ? 'ring-2 ring-primary' : ''"
          >
            <img
              :src="img.dataUrl"
              :alt="img.name"
              class="aspect-[4/3] w-full object-cover"
            />
            <div class="absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-1.5">
              <UiBadge
                v-if="img.thumbnail"
                variant="primary"
                size="xs"
                class="shadow-sm"
              >
                ★ Cover
              </UiBadge>
              <span v-else />
              <button
                type="button"
                class="rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-semibold text-destructive shadow-sm hover:bg-card focus-ring"
                @click="removeImage(img.id)"
              >
                ✕ Remove
              </button>
            </div>
            <div class="flex items-center justify-between gap-1 border-t border-border bg-card px-2 py-1.5">
              <button
                type="button"
                class="rounded p-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-ring disabled:opacity-30"
                :disabled="idx === 0"
                title="Move left"
                @click="moveImage(img.id, -1)"
              >
                ←
              </button>
              <button
                type="button"
                class="flex-1 truncate rounded px-1 text-[11px] font-semibold transition-colors duration-150 ease-out focus-ring"
                :class="img.thumbnail
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'"
                :title="img.thumbnail ? 'This is the cover' : 'Set as cover'"
                @click="setThumbnail(img.id)"
              >
                {{ img.thumbnail ? '★ Cover' : '☆ Set as cover' }}
              </button>
              <button
                type="button"
                class="rounded p-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-ring disabled:opacity-30"
                :disabled="idx === form.images.length - 1"
                title="Move right"
                @click="moveImage(img.id, 1)"
              >
                →
              </button>
            </div>
          </div>
        </div>

        <!-- Embeddable media. Both optional. The website's property
             page renders the YouTube player + SlideShare deck under
             the photo gallery when these are set. Stored in
             listings.attributes.media.* — see buildAttributesPayload(). -->
        <div class="rounded-lg border border-border bg-muted/20 p-4">
          <p class="mb-3 text-sm font-semibold text-foreground">
            Media embeds <span class="ml-1 text-[11px] font-normal text-muted-foreground">(optional)</span>
          </p>
          <div class="grid gap-4 md:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">YouTube video ID</span>
              <input
                v-model="form.youtube_id"
                type="text"
                placeholder="e.g. dQw4w9WgXcQ"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              />
              <span class="mt-1 block text-[11px] text-muted-foreground">
                Just the ID — the 11-char string after <code class="rounded bg-muted px-1">v=</code> in the URL.
              </span>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-muted-foreground">SlideShare deck ID</span>
              <input
                v-model="form.slideshare_id"
                type="text"
                placeholder="e.g. 12345678"
                class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
              />
              <span class="mt-1 block text-[11px] text-muted-foreground">
                Optional — for floor plan / brochure decks hosted on SlideShare.
              </span>
            </label>
          </div>
        </div>

        <label class="block">
          <span class="mb-1 block text-sm font-semibold text-foreground">Listing remarks (optional)</span>
          <textarea
            v-model="form.remarks"
            rows="3"
            placeholder="Internal notes for your team — won't be shown publicly."
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
          />
        </label>
      </div>

      <!-- ============================================================ -->
      <!-- STEP 6 — REVIEW                                                -->
      <!-- ============================================================ -->
      <div v-else-if="step === 6" class="space-y-5">
        <h3 class="text-lg font-bold text-foreground">Review</h3>

        <div class="grid gap-3 md:grid-cols-2">
          <div class="rounded-lg border border-border bg-muted/30 p-4">
            <p class="text-eyebrow">Basics</p>
            <dl class="mt-2 space-y-1 text-xs">
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Category</dt><dd class="capitalize">{{ form.category }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Listed for</dt><dd>{{ [form.for_rent ? 'Rent' : null, form.for_sale ? 'Sale' : null].filter(Boolean).join(' + ') || '—' }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Type</dt><dd>{{ buildingTypeLabel || '—' }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Title</dt><dd class="font-semibold text-foreground">{{ form.title || '—' }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Available from</dt><dd>{{ form.availability_date || '—' }}</dd></div>
            </dl>
          </div>

          <div class="rounded-lg border border-border bg-muted/30 p-4">
            <p class="text-eyebrow">Location</p>
            <dl class="mt-2 space-y-1 text-xs">
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Building</dt><dd>{{ buildings.find(b => b.id === form.building_id)?.building_name || form.building_name_input || '—' }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Address</dt><dd>{{ form.street_address || '—' }}{{ form.unit_number ? ` · Unit ${form.unit_number}` : '' }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Barangay</dt><dd>{{ filteredBarangays.find(b => b.id === form.barangay_id)?.name || '—' }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">City</dt><dd>{{ cities.find(c => c.id === form.city_id)?.name || '—' }}</dd></div>
              <div v-if="form.developer_name" class="flex gap-2"><dt class="w-28 text-muted-foreground">Developer</dt><dd>{{ form.developer_name }}</dd></div>
              <div v-if="form.year_built" class="flex gap-2"><dt class="w-28 text-muted-foreground">Year built</dt><dd>{{ form.year_built }}</dd></div>
            </dl>
          </div>

          <div class="rounded-lg border border-border bg-muted/30 p-4">
            <p class="text-eyebrow">Pricing</p>
            <dl class="mt-2 space-y-1 text-xs">
              <div v-if="form.for_rent" class="flex gap-2">
                <dt class="w-28 text-muted-foreground">Rent</dt>
                <dd>
                  ₱{{ Number(form.rent_price).toLocaleString() }} / month
                  <span v-if="calcRentDiscountPct > 0" class="ml-1 text-success">↓ {{ calcRentDiscountPct }}%</span>
                  <span v-if="calcRentPps > 0" class="ml-1 text-muted-foreground">· ₱{{ calcRentPps.toLocaleString() }}/sqm</span>
                </dd>
              </div>
              <div v-if="form.for_sale" class="flex gap-2">
                <dt class="w-28 text-muted-foreground">Sale</dt>
                <dd>
                  ₱{{ Number(form.sale_price).toLocaleString() }}
                  <span v-if="calcSaleDiscountPct > 0" class="ml-1 text-success">↓ {{ calcSaleDiscountPct }}%</span>
                  <span v-if="calcSalePps > 0" class="ml-1 text-muted-foreground">· ₱{{ calcSalePps.toLocaleString() }}/sqm</span>
                </dd>
              </div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Floor area</dt><dd>{{ form.floor_area || '—' }} sqm</dd></div>
              <div v-if="form.lot_area" class="flex gap-2"><dt class="w-28 text-muted-foreground">Lot area</dt><dd>{{ form.lot_area }} sqm</dd></div>
              <div v-if="form.for_rent" class="flex gap-2">
                <dt class="w-28 text-muted-foreground">Lease</dt>
                <dd>
                  {{ form.lease_term }} {{ form.lease_term_unit }}
                  · {{ form.rent_advance }} {{ form.rent_advance_unit }} adv
                  · {{ form.security_deposit }} {{ form.security_deposit_unit }} dep
                </dd>
              </div>
            </dl>
          </div>

          <div class="rounded-lg border border-border bg-muted/30 p-4">
            <p class="text-eyebrow">Details</p>
            <dl class="mt-2 space-y-1 text-xs">
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Beds / Baths</dt><dd>{{ form.bedrooms }} / {{ form.bathrooms }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Parking</dt><dd>{{ form.parking_spaces }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Condition</dt><dd>{{ conditionLabel || '—' }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Amenities</dt><dd>{{ selectedAmenityNames.length === 0 ? '—' : `${selectedAmenityNames.length} (${selectedAmenityNames.slice(0, 4).join(', ')}${selectedAmenityNames.length > 4 ? '…' : ''})` }}</dd></div>
              <div class="flex gap-2"><dt class="w-28 text-muted-foreground">Photos</dt><dd>{{ form.images.length }} {{ thumbnailImage ? `(cover: ${thumbnailImage.name})` : '(no thumbnail)' }}</dd></div>
              <div v-if="form.youtube_id || form.slideshare_id" class="flex gap-2">
                <dt class="w-28 text-muted-foreground">Media</dt>
                <dd>
                  <span v-if="form.youtube_id">YouTube ✓</span>
                  <span v-if="form.youtube_id && form.slideshare_id"> · </span>
                  <span v-if="form.slideshare_id">SlideShare ✓</span>
                </dd>
              </div>
            </dl>
          </div>

          <!-- Commercial summary card. Only renders when at least one
               commercial field is filled. Mirrors the structure of the
               other review cards for visual consistency. -->
          <div
            v-if="form.category === 'commercial' && (
              form.commercial_building_class || form.commercial_aircon ||
              form.commercial_aircon_operation || form.commercial_escalation !== '' ||
              form.commercial_telcos || form.commercial_office_floor ||
              form.commercial_office_type || form.commercial_office_setup ||
              form.commercial_occupant_number !== ''
            )"
            class="rounded-lg border border-border bg-muted/30 p-4 md:col-span-2"
          >
            <p class="text-eyebrow">Commercial details</p>
            <dl class="mt-2 grid gap-x-6 gap-y-1 text-xs md:grid-cols-2">
              <div v-if="form.commercial_building_class" class="flex gap-2"><dt class="w-28 text-muted-foreground">Class</dt><dd>{{ form.commercial_building_class }}</dd></div>
              <div v-if="form.commercial_office_floor" class="flex gap-2"><dt class="w-28 text-muted-foreground">Floor</dt><dd>{{ form.commercial_office_floor }}</dd></div>
              <div v-if="form.commercial_aircon" class="flex gap-2"><dt class="w-28 text-muted-foreground">Aircon</dt><dd>{{ form.commercial_aircon }}{{ form.commercial_aircon_operation ? ` · ${form.commercial_aircon_operation}` : '' }}</dd></div>
              <div v-if="form.commercial_office_type || form.commercial_office_setup" class="flex gap-2"><dt class="w-28 text-muted-foreground">Office</dt><dd>{{ [form.commercial_office_type, form.commercial_office_setup].filter(Boolean).join(' · ') }}</dd></div>
              <div v-if="form.commercial_escalation !== ''" class="flex gap-2"><dt class="w-28 text-muted-foreground">Escalation</dt><dd>{{ form.commercial_escalation }}% / yr</dd></div>
              <div v-if="form.commercial_occupant_number !== ''" class="flex gap-2"><dt class="w-28 text-muted-foreground">Occupants</dt><dd>{{ form.commercial_occupant_number }}</dd></div>
              <div v-if="form.commercial_telcos" class="flex gap-2 md:col-span-2"><dt class="w-28 text-muted-foreground">Telcos</dt><dd>{{ form.commercial_telcos }}</dd></div>
            </dl>
          </div>
        </div>

        <!-- Photo strip -->
        <div v-if="form.images.length > 0" class="flex gap-2 overflow-x-auto pb-2">
          <div
            v-for="img in form.images"
            :key="img.id"
            class="relative h-20 w-28 shrink-0 overflow-hidden rounded-md border border-border"
            :class="img.thumbnail ? 'ring-2 ring-primary' : ''"
          >
            <img :src="img.dataUrl" :alt="img.name" class="h-full w-full object-cover" />
            <UiBadge
              v-if="img.thumbnail"
              variant="primary"
              size="xs"
              class="absolute left-1 top-1"
            >
              ★
            </UiBadge>
          </div>
        </div>

        <!-- Publish state hint -->
        <div
          class="rounded-lg border px-4 py-3 text-sm"
          :class="form.images.length === 0
            ? 'border-warning/30 bg-warning/10 text-warning'
            : (thumbnailImage
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-warning/30 bg-warning/10 text-warning')"
        >
          <template v-if="form.images.length === 0">
            ⚠️ No photos uploaded — this listing will be saved as a <strong>draft</strong>. You can add photos and publish later from the listing detail page.
          </template>
          <template v-else-if="!thumbnailImage">
            ⚠️ Thumbnail not selected — go back to <button class="underline" type="button" @click="step = 5">Photos</button> and tap a star to designate the cover image before publishing.
          </template>
          <template v-else>
            ✓ Ready to publish — {{ form.images.length }} photos, cover designated.
          </template>
        </div>
      </div>
    </UiCard>

    <!-- Footer nav -->
    <div class="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:px-5">
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:opacity-50"
        :disabled="step === 1 || isSaving"
        @click="prevStep"
      >
        ← Back
      </button>
      <span class="ml-1 text-xs text-muted-foreground">Step {{ step }} of {{ STEPS.length }}</span>
      <!-- Edit-mode "View history" pulls up the existing
           ListingHistoryDrawer (already wired to /api/listings/:id/activities,
           with field-level diffs from the listings_audit_diff trigger). -->
      <button
        v-if="isEdit"
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring"
        @click="historyDrawerOpen = true"
      >
        ⏱ View history
      </button>
      <div class="ml-auto flex items-center gap-2">
        <button
          v-if="step === 6"
          type="button"
          class="rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:opacity-50"
          :disabled="isSaving"
          @click="submit('draft')"
        >
          {{ isEdit ? 'Save as draft' : 'Save as draft' }}
        </button>
        <button
          v-if="step < 6"
          type="button"
          class="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
          :disabled="isSaving"
          @click="nextStep"
        >
          Continue →
        </button>
        <button
          v-else
          type="button"
          class="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
          :disabled="isSaving"
          @click="submit('publish')"
        >
          {{ isSaving
            ? (isEdit ? 'Saving…' : 'Publishing…')
            : (isEdit ? 'Save changes' : 'Publish listing') }}
        </button>
      </div>
    </div>

    <ListingHistoryDrawer
      v-if="isEdit"
      :open="historyDrawerOpen"
      :listing-id="props.listingId ?? null"
      @close="historyDrawerOpen = false"
    />
  </div>
</template>
