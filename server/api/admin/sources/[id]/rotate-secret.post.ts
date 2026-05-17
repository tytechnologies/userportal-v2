// Admin — rotate a partner source's ingest secret.
//
// POST /api/admin/sources/:id/rotate-secret
//
// Calls the rotate_listing_source_secret RPC (mig 506000014 + 513000006).
// The new secret is stored in vault and returned ONCE — operator must
// capture and hand it to the partner.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')

    const sourceId = Number(getRouterParam(event, 'id') || '0')
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid source id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .rpc('rotate_listing_source_secret', { p_id: sourceId })

    if (error) {
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: 'Source not found' })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { bearer: data as string }
  },
})
