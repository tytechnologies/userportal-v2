// List buildings. Reference-data shape: every authenticated user can
// query, optional search by name. RLS allows reads to all
// authenticated; the new SELECT policy doesn't gate on role.
//
// Pagination: ?page=1&page_size=20. Search: ?search=foo (ilike on name).
// Order: name ASC by default.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().max(200).optional(),
  city_id: z.coerce.number().int().positive().optional(),
  /** 'true' / 'false' — filter to curated only / auto-only.
   *  Omit for all (legacy callers). */
  is_curated: z.coerce.boolean().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const page = (query as any).page ?? 1
    const pageSize = (query as any).page_size ?? 50
    const search = (query as any).search as string | undefined
    const cityId = (query as any).city_id as number | undefined

    const isCurated = (query as any).is_curated as boolean | undefined

    let q: any = (supabase as any)
      .from('buildings')
      .select('id, name, slug, address, city_id, developer_id, zonal_value, description, amenities, latitude, longitude, is_curated, created_at, updated_at', { count: 'exact' })
      .order('name', { ascending: true })

    if (search && search.trim()) {
      // Strip PostgREST DSL chars from user-controlled value before
      // interpolating into the OR filter; same hygiene as listings/search.
      const safe = search.replace(/[%,()*]/g, '').trim()
      q = q.ilike('name', `%${safe}%`)
    }
    if (cityId) q = q.eq('city_id', cityId)
    if (typeof isCurated === 'boolean') q = q.eq('is_curated', isCurated)

    const from = (page - 1) * pageSize
    const to = from + pageSize - 1
    q = q.range(from, to)

    const { data, error, count } = await q
    if (error) {
      logger.error({ err: error.message, op: 'buildings.list' }, 'buildings_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      data: data ?? [],
      total: count ?? 0,
      page,
      page_size: pageSize,
      total_pages: count ? Math.ceil(count / pageSize) : 0,
    }
  },
})
