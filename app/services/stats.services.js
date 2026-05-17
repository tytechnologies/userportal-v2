// Dashboard stats. Reads from `listings` (source of truth for ownership
// + pricing) — `listing_details` is filter-layer-only and does not have
// the `created_by` / pricing / status columns this view needs.
//
// Five queries run in parallel; counts use the cheap `head: true` mode
// where we don't need rows; only the for-sale / for-rent buckets pull
// the actual rows because the dashboard sums their prices.
//
// Every result is null-safe: a failing bucket logs to console and lands
// as 0/[] in the returned object so the dashboard never sees an undefined
// or null derefs `.length` on it.

import { rowsOrEmpty } from '~/utils/supabaseHelpers'

const EMPTY_VIEWS = {
  jan: 45231,
  feb: 12897,
  mar: 67432,
  apr: 23156,
  may: 89124,
  jun: 34789,
  jul: 56123,
  aug: 98765,
  sep: 43210,
  oct: 65432,
  nov: 78901,
  dec: 23456,
}

// Logs failures with a stable label so they're greppable in production.
function logIf(label, error) {
  if (error) console.error(`[stats] ${label} failed:`, error.message ?? error)
}

export default {
  async getStats() {
    if (!import.meta.client) return []

    const stats = {
      totalListings: 0,
      listingsForSale: [],
      listingsForSaleCount: 0,
      listingsForRent: [],
      listingsForRentCount: 0,
      residentialListingsCount: 0,
      commercialListingsCount: 0,
      views: EMPTY_VIEWS,
    }

    const user = useSupabaseUser()
    if (!user.value?.id) return { value: stats }

    const supabase = useSupabaseClient()
    const userId = user.value.id

    // `head: true` skips the row payload — for COUNT-only queries this
    // shaves the wire transfer to almost nothing. Only the for-sale /
    // for-rent buckets pull rows because we need to sum prices.
    // listings TABLE has deleted_at; filter it out so soft-deleted rows
    // don't inflate the dashboard counts. created_by is uuid post-Phase-4.
    const ownedAlive = (q) => q.eq('created_by', userId).is('deleted_at', null)

    const [
      total,
      forSale,
      forRent,
      residential,
      commercial,
    ] = await Promise.all([
      // Reads from `listings` (the TABLE), not `listing_details`. The
      // view's `created_by` is text holding legacy name strings; the
      // table's `created_by` is uuid after the Phase-4 quarantine
      // migration. Auth-uid filters only match against the table.
      ownedAlive(supabase.from('listings').select('id', { count: 'exact', head: true })),
      ownedAlive(
        supabase.from('listings').select('id, sale_price').eq('for_sale', true),
      ),
      ownedAlive(
        supabase.from('listings').select('id, rent_price').eq('for_rent', true),
      ),
      ownedAlive(
        supabase
          .from('listings')
          .select('id', { count: 'exact', head: true })
          .eq('property_category', 'residential'),
      ),
      ownedAlive(
        supabase
          .from('listings')
          .select('id', { count: 'exact', head: true })
          .eq('property_category', 'commercial'),
      ),
    ])

    logIf('total listings', total.error)
    logIf('for-sale listings', forSale.error)
    logIf('for-rent listings', forRent.error)
    logIf('residential listings', residential.error)
    logIf('commercial listings', commercial.error)

    const forSaleRows = rowsOrEmpty(forSale.data)
    const forRentRows = rowsOrEmpty(forRent.data)

    stats.totalListings = total.count ?? 0
    stats.listingsForSale = forSaleRows
    stats.listingsForSaleCount = forSaleRows.length
    stats.listingsForRent = forRentRows
    stats.listingsForRentCount = forRentRows.length
    stats.residentialListingsCount = residential.count ?? 0
    stats.commercialListingsCount = commercial.count ?? 0

    return { value: stats }
  },
}
