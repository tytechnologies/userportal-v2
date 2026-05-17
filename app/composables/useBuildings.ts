// Buildings data layer. Goes through /api/buildings/* server routes —
// no direct supabase calls in the client (per the audit's
// architectural-risks recommendation).
//
// Replaces (and gradually retires) app/services/buildings.services.js.

export type Building = {
  id: number
  name: string
  slug: string | null
  address: string | null
  city_id: number | null
  developer_id: number | null
  zonal_value: number | null
  description: string | null
  amenities: string[]
  latitude: number | null
  longitude: number | null
  is_curated: boolean
  created_by: string | null
  created_at: string
  updated_at: string
  /** Legacy mirror columns kept for backwards compat. */
  building_name?: string | null
  property_id?: number | null
}

export type CreateBuildingInput = {
  name: string
  slug?: string
  address?: string | null
  city_id?: number | null
  developer_id?: number | null
  zonal_value?: number | null
  description?: string | null
  amenities?: string[]
  latitude?: number | null
  longitude?: number | null
  is_curated?: boolean
}

export type UpdateBuildingInput = Partial<CreateBuildingInput>

export type BuildingsListResult = {
  data: Building[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export function useBuildings() {
  async function listBuildings(opts: {
    page?: number
    pageSize?: number
    search?: string
    cityId?: number
    isCurated?: boolean
  } = {}): Promise<BuildingsListResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('page_size', String(opts.pageSize))
    if (opts.search) params.set('search', opts.search)
    if (opts.cityId) params.set('city_id', String(opts.cityId))
    if (typeof opts.isCurated === 'boolean') params.set('is_curated', String(opts.isCurated))
    const qs = params.toString()
    const url = qs ? `/api/buildings?${qs}` : '/api/buildings'
    return await $fetch<BuildingsListResult>(url)
  }

  async function getBuilding(id: number): Promise<Building & { listings_count: number }> {
    if (!Number.isFinite(id)) throw new Error('Invalid building id')
    return await $fetch<Building & { listings_count: number }>(`/api/buildings/${id}`)
  }

  async function createBuilding(input: CreateBuildingInput): Promise<Building> {
    return await $fetch<Building>('/api/buildings', {
      method: 'POST',
      body: input,
    })
  }

  async function updateBuilding(id: number, patch: UpdateBuildingInput): Promise<Building> {
    if (!Number.isFinite(id)) throw new Error('Invalid building id')
    return await $fetch<Building>(`/api/buildings/${id}`, {
      method: 'PATCH',
      body: patch,
    })
  }

  async function deleteBuilding(id: number): Promise<void> {
    if (!Number.isFinite(id)) throw new Error('Invalid building id')
    await $fetch(`/api/buildings/${id}`, { method: 'DELETE' })
  }

  return {
    listBuildings,
    getBuilding,
    createBuilding,
    updateBuilding,
    deleteBuilding,
  }
}
