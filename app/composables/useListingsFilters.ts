import { computed, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUrlState } from '~/composables/useUrlState'

// Phase 1 listings-page filter state, two-way bound to the URL query string.
// Each key has its own URL param. A filter is "set" when its value differs
// from the default (`''` for strings, defaults below for numerics) — defaults
// are stripped from the URL by useUrlState() so shared links stay clean.
//
// Usage:
//   const { filters, hasAny, reset, asQueryParams } = useListingsFilters()
//   watch(filters, (next) => fetchListings(next.asQueryParams()))
//
// The compatibility goal: existing applyFilters() / resetFilters() handlers
// in pages/listings/index.vue continue to work — this composable just
// provides the URL-sync layer alongside.

export type ListingsFilters = {
  category: '' | 'residential' | 'commercial'
  status: '' | 'available' | 'reserved' | 'sold' | 'rented'
  city: string
  minPrice: string
  maxPrice: string
  searchColumn: string
  searchValue: string
  // Phase 4: ownership scope. Empty = "all visible" (RLS still applies).
  // 'mine' = only my listings; 'team' = anyone on my team.
  ownership: '' | 'mine' | 'team'
}

const DEFAULTS: ListingsFilters = {
  category: '',
  status: '',
  city: '',
  minPrice: '',
  maxPrice: '',
  searchColumn: '',
  searchValue: '',
  ownership: '',
}

export function useListingsFilters() {
  // Each filter is its own ref bound to a URL param. Naming is short and
  // human-readable in the URL (?category=residential&status=available).
  const category = useUrlState('category', DEFAULTS.category)
  const status = useUrlState('status', DEFAULTS.status)
  const city = useUrlState('city', DEFAULTS.city)
  const minPrice = useUrlState('minPrice', DEFAULTS.minPrice)
  const maxPrice = useUrlState('maxPrice', DEFAULTS.maxPrice)
  const searchColumn = useUrlState('searchColumn', DEFAULTS.searchColumn)
  const searchValue = useUrlState('searchValue', DEFAULTS.searchValue)
  const ownership = useUrlState('ownership', DEFAULTS.ownership)

  // Convenience aggregator. Reads as a plain object so consumers can spread
  // it into existing filter-shaped APIs.
  const filters = computed<ListingsFilters>(() => ({
    category: category.value,
    status: status.value,
    city: city.value,
    minPrice: minPrice.value,
    maxPrice: maxPrice.value,
    searchColumn: searchColumn.value,
    searchValue: searchValue.value,
    ownership: ownership.value as ListingsFilters['ownership'],
  }))

  const hasAny = computed(() =>
    Object.entries(filters.value).some(
      ([k, v]) => v !== DEFAULTS[k as keyof ListingsFilters],
    ),
  )

  // Reset all filters to defaults. Triggers the URL-sync watchers in
  // useUrlState, so the params disappear from the URL too.
  const reset = () => {
    category.value = DEFAULTS.category
    status.value = DEFAULTS.status
    city.value = DEFAULTS.city
    minPrice.value = DEFAULTS.minPrice
    maxPrice.value = DEFAULTS.maxPrice
    searchColumn.value = DEFAULTS.searchColumn
    searchValue.value = DEFAULTS.searchValue
    ownership.value = DEFAULTS.ownership
  }

  // Patch a subset of filters at once. Existing applyFilters() handlers in
  // index.vue can call this with the partial they collected from the modal.
  const setMany = (patch: Partial<ListingsFilters>) => {
    if (patch.category !== undefined) category.value = patch.category
    if (patch.status !== undefined) status.value = patch.status
    if (patch.city !== undefined) city.value = patch.city
    if (patch.minPrice !== undefined) minPrice.value = patch.minPrice
    if (patch.maxPrice !== undefined) maxPrice.value = patch.maxPrice
    if (patch.searchColumn !== undefined) searchColumn.value = patch.searchColumn
    if (patch.searchValue !== undefined) searchValue.value = patch.searchValue
    if (patch.ownership !== undefined) ownership.value = patch.ownership
  }

  // Shape compatible with the listings service's `filters` parameter.
  // Drops empties so the underlying query doesn't add noise filters.
  const asQueryParams = () => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(filters.value)) {
      if (v !== '' && v != null) out[k] = String(v)
    }
    return out
  }

  return {
    // individual refs (handy for v-model in the panel UI)
    category,
    status,
    city,
    minPrice,
    maxPrice,
    searchColumn,
    searchValue,
    ownership,
    // aggregates
    filters,
    hasAny,
    // actions
    reset,
    setMany,
    asQueryParams,
  }
}
