// Remove a milestone template item.
//
// DELETE /api/admin/milestone-templates/:id/items/:itemId
//
// Existing per-deal milestones snapshotted from this item are NOT
// affected — source_template_item_id becomes NULL via the FK's
// ON DELETE SET NULL.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const templateId = getRouterParam(event, 'id')
    const itemId = getRouterParam(event, 'itemId')
    if (!templateId || !/^[0-9a-f-]{36}$/i.test(templateId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid template id' })
    }
    if (!itemId || !/^[0-9a-f-]{36}$/i.test(itemId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid item id' })
    }

    const client = await serverSupabaseClient(event)
    const { error } = await (client as any)
      .from('deal_milestone_template_items')
      .delete()
      .eq('id', itemId)
      .eq('template_id', templateId)

    if (error) {
      logger.error(
        { err: error.message, op: 'milestone_templates.delete_item', templateId, itemId },
        'milestone_templates_delete_item_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'admin.milestone_template_item_removed',
      entity: 'deal',
      entityId: null,
      metadata: { template_id: templateId, item_id: itemId },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestone_templates_delete_item_activity_log_failed',
      )
    })

    return { ok: true }
  },
})
