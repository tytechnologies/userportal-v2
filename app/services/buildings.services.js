// Legacy services shim. Keeps the public method shapes
// (_getBuildings / _getBuilding / _getBuildingNames) so existing
// callers don't break, but routes through /api/buildings instead of
// hitting Supabase directly.
//
// Each row is normalized with BOTH the new canonical fields (id,
// name, slug, address, ...) AND the legacy aliases (property_id,
// building_name) so callers that read either shape keep working
// during the transition. New code should use useBuildings() in
// app/composables/useBuildings.ts.

function normalize(row) {
  if (!row) return null
  return {
    ...row,
    // Legacy mirrors — guarantees the old shape always works.
    property_id: row.property_id ?? row.id,
    building_name: row.building_name ?? row.name,
  }
}

export default {
  methods: {
    async _getBuildings(params = {}) {
      const {
        page = 1,
        perPage = 10,
        sortColumn,
        sortOrder,
        filters = {}
      } = params

      // The server endpoint exposes a 'search' param matching name
      // OR building_name. Pull a free-text 'search' filter out and
      // forward it; ignore other column-keyed filters (they were
      // unused by callers in practice but technically supported via
      // ilike). If they come back, extend the server endpoint.
      const url = new URL('/api/buildings', typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
      url.searchParams.set('page', page)
      url.searchParams.set('page_size', perPage)
      if (filters.search) url.searchParams.set('search', String(filters.search))
      if (filters.name) url.searchParams.set('search', String(filters.name))
      if (filters.city_id) url.searchParams.set('city_id', String(filters.city_id))

      try {
        const res = await $fetch(url.pathname + url.search)
        return {
          data: (res?.data ?? []).map(normalize),
          total: res?.total ?? 0,
          page,
          perPage,
        }
      } catch (err) {
        console.error('Error fetching buildings:', err)
        throw new Error(err?.statusMessage || err?.message || 'Failed to fetch buildings')
      }
    },

    async _getBuilding(id) {
      try {
        const row = await $fetch(`/api/buildings/${id}`)
        return normalize(row)
      } catch (err) {
        console.error('Error fetching building:', err)
        throw new Error(err?.statusMessage || err?.message || 'Failed to fetch building')
      }
    },

    async _getBuildingNames({ page = 1, perPage = 10, search = '', fetchAll = false } = {}) {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('page_size', String(fetchAll ? 200 : perPage))
      if (search) params.set('search', search)
      try {
        const res = await $fetch(`/api/buildings?${params.toString()}`)
        return {
          data: (res?.data ?? []).map((b) => ({
            ...normalize(b),
            // Older form code consumed { building_name, property_id };
            // surface those at the top level so we don't break it.
            building_name: b.name ?? b.building_name ?? '',
            property_id: b.id ?? b.property_id ?? null,
          })),
          total: res?.total ?? 0,
          page,
          perPage,
        }
      } catch (err) {
        console.error('Error fetching building names:', err)
        throw new Error(err?.statusMessage || err?.message || 'Failed to fetch building names')
      }
    },
  },
}
