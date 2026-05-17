// Admin — delete a ticker message.
//
// DELETE /api/admin/ticker/:id
//
// Hard delete. To temporarily hide, prefer PATCH with enabled=false
// so the row + its source_config are preserved.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid ticker id' })
    }
    const supabase = await serverSupabaseClient(event)
    const { error } = await (supabase as any)
      .from('marketing_ticker_messages')
      .delete()
      .eq('id', id)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { ok: true }
  },
})
