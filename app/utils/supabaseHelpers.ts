// Shared helpers for Supabase queries.
//
// Architectural rule (post-refactor):
//   listing_details → filter layer ONLY (id + city/barangay/slugs)
//   listings        → source of truth (created_by, pricing, status, …)
//
// Any code that needs a non-filter column MUST go through `listings`.
// Anything that filters by location/slug MAY go through `listing_details`
// for performance, then hydrate from `listings` via `.in('id', ids)`.

/**
 * Returns `data` if it's an array, otherwise an empty array.
 * Lets callers write `rowsOrEmpty(data).length` without a separate
 * null check after every PostgREST round-trip.
 */
export function rowsOrEmpty<T>(data: T[] | null | undefined): T[] {
  return Array.isArray(data) ? data : []
}

/**
 * Logs a Supabase `{ data, error }` pair and returns rows-or-empty.
 * The `op` label shows up in console so the failing query is identifiable
 * without needing source maps in production.
 */
export function unwrapRows<T>(
  op: string,
  result: { data: T[] | null; error: { message?: string } | null },
): T[] {
  if (result.error) {
    console.error(`[supabase] ${op} failed:`, result.error.message ?? result.error)
    return []
  }
  return rowsOrEmpty(result.data)
}

/**
 * Two-step pattern: filter on the lightweight materialized view, then
 * hydrate the real columns from `listings`. Returns an empty array on
 * any failure — callers never see a null/throw.
 *
 * Example:
 *   const rows = await filterIdsThenFetch(supabase, {
 *     filter: (q) => q.eq('city_id', cityId),
 *     select: '*',
 *   })
 *
 * The `filter` callback runs against `listing_details` and receives the
 * already-built `select('id')` query. Anything you can chain on a
 * Supabase query builder is fair game (.eq, .in, .or, .ilike, …).
 *
 * `select` is the projection passed to `listings.select(...)`. Defaults
 * to '*'. Add `, options.extra` if you need to chain `.order()` or
 * `.limit()` on the listings step — pass `applyToListings` for that.
 */
export async function filterIdsThenFetch<T = any>(
  supabase: any,
  options: {
    filter: (q: any) => any
    select?: string
    /** Apply ordering / limit / range on the listings query. */
    applyToListings?: (q: any) => any
  },
): Promise<T[]> {
  const filterQuery = options.filter(
    supabase.from('listing_details').select('id'),
  )
  const filtered = await filterQuery
  const ids = unwrapRows<{ id: number | string }>('listing_details filter', filtered)
    .map((row) => row.id)
    .filter((id) => id !== null && id !== undefined)

  if (ids.length === 0) return []

  let listingsQuery = supabase
    .from('listings')
    .select(options.select ?? '*')
    .in('id', ids)

  if (options.applyToListings) listingsQuery = options.applyToListings(listingsQuery)

  const fetched = await listingsQuery
  return unwrapRows<T>('listings hydrate', fetched) as T[]
}
