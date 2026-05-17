import { z } from 'zod'

const numericFromString = z
  .union([z.string(), z.number()])
  .transform((v) => (v === '' || v === null || v === undefined ? undefined : Number(v)))
  .refine((v) => v === undefined || !Number.isNaN(v), { message: 'must be numeric' })
  .optional()

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .optional()

// Search string is interpolated into a Postgres `or()` filter in the controller —
// strip the chars that have meaning in PostgREST DSL to neutralize injection.
const safeSearch = z
  .string()
  .max(200)
  .transform((s) => s.replace(/[%,()*]/g, ''))
  .optional()

export const listingsQuerySchema = z.object({
  page: numericFromString,
  pageSize: numericFromString,
  sortBy: z
    .enum([
      'id',
      'created_at',
      'updated_at',
      'price',
      'price_per_sqm',
      'bedrooms',
      'bathrooms',
      'parking_spaces',
      'floor_area',
      'lot_area',
      'availability_date',
      'listing_title',
    ])
    .optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),

  search: safeSearch,
  forId: z.string().optional(),
  typeId: z.string().optional(),
  conditionId: z.string().optional(),
  parking: numericFromString,
  parking_spaces: numericFromString,
  availabilityFrom: isoDate,
  availabilityTo: isoDate,
  minBedroom: numericFromString,
  maxBedroom: numericFromString,
  minBathroom: numericFromString,
  maxBathroom: numericFromString,
  minPrice: numericFromString,
  maxPrice: numericFromString,
  minPps: numericFromString,
  maxPps: numericFromString,
  minFloorArea: numericFromString,
  maxFloorArea: numericFromString,
  minLotArea: numericFromString,
  maxLotArea: numericFromString,

  // Phase-4 ownership scope. Server-applied filter, layered on top of RLS:
  //   'mine' → only listings created by the calling user
  //   'team' → only listings whose creator shares the caller's team_id
  //   ''/undefined → no narrowing (RLS still applies; agents see only own + unowned)
  ownership: z.enum(['mine', 'team']).optional(),
})

export type ListingsQuery = z.infer<typeof listingsQuerySchema>

// Columns the listings table is in the process of dropping (migrations
// 20260429000003 and 20260429000004). The form/repo writes contact_id +
// city_id + barangay_id instead; these denormalized aliases must never
// reach the API. Refusing them here is cheaper than surfacing a 500 from
// Postgres after the columns are gone.
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

// TODO: tighten the rest of this once the listings table schema is
// canonicalized. Today the create-listing path inserts ~40 raw columns;
// locking the full shape down is out of scope. For now we only enforce
// the deny-list — every column that's no longer writable at the DB level.
export const listingCreateSchema = z
  .record(z.unknown())
  .superRefine((payload, ctx) => {
    for (const field of LEGACY_LISTING_FIELDS) {
      if (field in payload) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Legacy field "${field}" is no longer accepted. Send contact_id / city_id / barangay_id instead.`,
        })
      }
    }
  })

export type ListingCreate = z.infer<typeof listingCreateSchema>

export const listingRemarksSchema = z.object({
  remarks: z.string().max(5000),
})

export type ListingRemarks = z.infer<typeof listingRemarksSchema>
