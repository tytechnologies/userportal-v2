import type { SupabaseClient } from '@supabase/supabase-js'

// Single-query analytics aggregation. Replaces the per-metric pattern in
// stats.services.js (which fired 5 separate `.from(...).select('*')` calls
// for the same user's listings) with one slim query and a client-side fold.
//
// Tradeoff: fetching N rows once vs. 5 separate counts. With <10k listings
// per user this is fine; if the per-user listing count grows past 50k we
// should switch to a Postgres view returning pre-aggregated rows.

export type AnalyticsSummary = {
  totalListings: number
  active: number
  archived: number
  forSale: number
  forRent: number
  avgSalePrice: number
  avgRentPrice: number
  byCategory: Record<string, number>
  byMonth: Array<{ month: string; count: number }>
}

const EMPTY: AnalyticsSummary = {
  totalListings: 0,
  active: 0,
  archived: 0,
  forSale: 0,
  forRent: 0,
  avgSalePrice: 0,
  avgRentPrice: 0,
  byCategory: {},
  byMonth: [],
}

type AnalyticsRow = {
  id: number
  is_online: boolean | null
  for_sale: boolean | null
  for_rent: boolean | null
  sale_price: number | null
  rent_price: number | null
  property_category: string | null
  created_at: string | null
}

const safeAvg = (values: number[]): number => {
  const filtered = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v) && v > 0)
  if (filtered.length === 0) return 0
  return filtered.reduce((sum, v) => sum + v, 0) / filtered.length
}

// Bucket created_at into year-month keys for the time-series chart. Twelve
// trailing months keeps the chart readable; sparse months get a 0 entry so
// the line doesn't have gaps.
const buildMonthBuckets = (rows: AnalyticsRow[]): Array<{ month: string; count: number }> => {
  const now = new Date()
  const buckets: Array<{ key: string; month: string; count: number }> = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const month = d.toLocaleString('en-US', { month: 'short' })
    buckets.push({ key, month, count: 0 })
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]))

  for (const row of rows) {
    if (!row.created_at) continue
    const d = new Date(row.created_at)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const bucket = byKey.get(key)
    if (bucket) bucket.count += 1
  }

  return buckets.map(({ month, count }) => ({ month, count }))
}

export async function fetchAnalyticsSummary(
  supabase: SupabaseClient,
  userId: string | null | undefined,
): Promise<AnalyticsSummary> {
  if (!userId) return EMPTY

  // Reads from `listings` (the TABLE), NOT the view. The view's
  // `created_by` is text holding legacy name strings; the table's
  // `created_by` is uuid after the Phase-4 quarantine. Filtering by
  // auth.uid() only works against the table. Every column the
  // aggregator reads is a base column present on listings directly.
  const { data, error } = await supabase
    .from('listings')
    .select(
      'id, is_online, for_sale, for_rent, sale_price, rent_price, property_category, created_at',
    )
    .eq('created_by', userId)
    .is('deleted_at', null)

  if (error) {
    console.error('[analytics] fetch failed:', error)
    return EMPTY
  }

  const rows = (data ?? []) as AnalyticsRow[]
  if (rows.length === 0) return EMPTY

  const summary: AnalyticsSummary = { ...EMPTY, totalListings: rows.length }

  const salePrices: number[] = []
  const rentPrices: number[] = []
  const byCategory: Record<string, number> = {}

  for (const row of rows) {
    if (row.is_online) summary.active += 1
    else summary.archived += 1

    if (row.for_sale) {
      summary.forSale += 1
      if (typeof row.sale_price === 'number') salePrices.push(row.sale_price)
    }
    if (row.for_rent) {
      summary.forRent += 1
      if (typeof row.rent_price === 'number') rentPrices.push(row.rent_price)
    }

    const cat = row.property_category || 'unknown'
    byCategory[cat] = (byCategory[cat] || 0) + 1
  }

  summary.avgSalePrice = safeAvg(salePrices)
  summary.avgRentPrice = safeAvg(rentPrices)
  summary.byCategory = byCategory
  summary.byMonth = buildMonthBuckets(rows)

  return summary
}
