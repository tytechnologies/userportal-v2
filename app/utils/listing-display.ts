// Helpers for reading display values off a listing row.
//
// During the Phase E + F migration window the listings row may carry both:
//   - normalized relational data: row.contact, row.city, row.barangay
//   - legacy denormalized columns: row.contact_name, row.city_name,
//     row.barangay_name
//
// All UI sites should go through these helpers. They prefer the joined
// relation, fall back to the legacy column, and finally to a placeholder.
// Once migrations 20260429000003 + 20260429000004 apply and the legacy
// columns are physically dropped, the fallbacks become dead code and can be
// removed in a follow-up sweep — but keeping them here means there is a
// single place to delete them, not 18.
//
// Type stays loose intentionally — callers pass in raw API rows (snake_case),
// not a strongly-typed Listing.

type Maybe<T> = T | null | undefined

interface ListingLike {
  contact?: Maybe<{ full_name?: Maybe<string>; email?: Maybe<string> }>
  contact_name?: Maybe<string>
  contact_email?: Maybe<string>

  city?: Maybe<{ name?: Maybe<string>; slug?: Maybe<string> }>
  city_name?: Maybe<string>
  city_slug?: Maybe<string>

  barangay?: Maybe<{ name?: Maybe<string>; slug?: Maybe<string> }>
  barangay_name?: Maybe<string>

  creator?: Maybe<{ full_name?: Maybe<string>; email?: Maybe<string> }>
  created_by_name?: Maybe<string>
  created_by_legacy?: Maybe<string>
}

const PLACEHOLDER = '—'

export function getContactName(row: Maybe<ListingLike>, fallback = PLACEHOLDER): string {
  return row?.contact?.full_name ?? row?.contact_name ?? fallback
}

export function getContactEmail(row: Maybe<ListingLike>, fallback = PLACEHOLDER): string {
  return row?.contact?.email ?? row?.contact_email ?? fallback
}

export function getCityName(row: Maybe<ListingLike>, fallback = PLACEHOLDER): string {
  return row?.city?.name ?? row?.city_name ?? fallback
}

export function getCitySlug(row: Maybe<ListingLike>, fallback = ''): string {
  return row?.city?.slug ?? row?.city_slug ?? fallback
}

export function getBarangayName(row: Maybe<ListingLike>, fallback = PLACEHOLDER): string {
  return row?.barangay?.name ?? row?.barangay_name ?? fallback
}

export function getCreatedByName(row: Maybe<ListingLike>, fallback = PLACEHOLDER): string {
  return (
    row?.creator?.full_name ??
    row?.creator?.email ??
    row?.created_by_name ??
    row?.created_by_legacy ??
    fallback
  )
}

// Convenience: build the standard column-card payload the listings table
// already builds in app/store/index.ts. Centralizing the field mapping here
// means new display sites get the same fallback logic for free.
export function buildListingDisplay(row: Maybe<ListingLike>) {
  return {
    contactName: getContactName(row),
    contactEmail: getContactEmail(row),
    cityName: getCityName(row),
    citySlug: getCitySlug(row),
    barangayName: getBarangayName(row),
    createdByName: getCreatedByName(row),
  }
}
