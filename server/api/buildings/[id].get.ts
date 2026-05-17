// Load a single building plus a count of listings linked via
// building_id. Useful for the building-detail page and the listing
// form's "you'll also see X listings" hint.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const raw = getRouterParam(event, 'id')
    const id = Number(raw)
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid building id' })
    }

    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('buildings')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'buildings.get', id }, 'buildings_get_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Building not found' })

    // Count linked listings — uses `head: true` so we don't pull rows.
    const { count: listingsCount } = await (supabase as any)
      .from('listings')
      .select('id', { count: 'exact', head: true })
      .eq('building_id', id)

    return { ...data, listings_count: listingsCount ?? 0 }
  },
})
