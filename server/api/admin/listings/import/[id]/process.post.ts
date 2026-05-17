// Admin — process a staged listing import batch.
//
// POST /api/admin/listings/import/:id/process
// Calls process_listing_import_batch(:id) RPC. Returns the per-
// outcome counts. Idempotent — re-running on a 'processed' batch
// returns the cached counts without re-doing work.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid batch id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('process_listing_import_batch', {
      p_batch_id: id,
    })
    if (error) {
      const status = error.code === '42501' ? 403 : error.code === '42704' ? 404 : 500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    const summary = Array.isArray(data) ? data[0] : data

    await (supabase as any).rpc('log_activity', {
      p_action:   'listing.import_batch_processed',
      p_metadata: { batch_id: id, ...summary },
    }).catch((err: any) =>
      console.warn('[admin/listings/import/:id/process] log_activity failed', err),
    )

    return { summary }
  },
})
