// Admin: read the active owner statement policy.
//
// GET /api/admin/property-owners/[id]/statement-policy

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const ownerId = getRouterParam(event, 'id')
    if (!ownerId || !/^[0-9a-f-]{36}$/i.test(ownerId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid owner id' })
    }

    const admin = getServerSupabaseAdmin()
    const { data, error } = await (admin as any)
      .from('owner_statement_policies')
      .select('*')
      .eq('property_owner_id', ownerId)
      .eq('status', 'active')
      .is('ended_at', null)
      .order('effective_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { policy: data ?? null }
  },
})
