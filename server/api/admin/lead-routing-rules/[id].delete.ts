// Hard-delete a lead-routing rule.
//
// DELETE /api/admin/lead-routing-rules/[id]
//
// Hard delete is intentional â€” disabled rules can stay around as
// `enabled=false` (PATCH); deleting actually removes the row when
// the operator no longer needs it. Audit row preserves the action.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid rule id' })
    }

    const admin = getServerSupabaseAdmin()
    const { data: existing } = await (admin as any)
      .from('lead_routing_rules')
      .select('id, name, action_kind, match_count')
      .eq('id', id)
      .maybeSingle()

    const { error } = await (admin as any)
      .from('lead_routing_rules')
      .delete()
      .eq('id', id)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      action: 'lead_routing_rule.deleted',
      entity: 'lead_routing_rule' as any,
      entityId: id,
      metadata: existing ?? { rule_id: id },
    })

    return { id, deleted: true }
  },
})
