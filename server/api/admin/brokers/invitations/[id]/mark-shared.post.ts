// Admin — stamp link_shared_at when an admin copies the invitation link.
//
// POST /api/admin/brokers/invitations/:id/mark-shared
//
// Lets the admin UI track which invitations have been distributed
// out-of-band (manually emailed by the admin, pasted in chat, etc.).
// Idempotent.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid invitation id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('broker_invitations')
      .update({ link_shared_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, link_shared_at')
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data)  throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })

    return { ok: true, link_shared_at: data.link_shared_at }
  },
})
