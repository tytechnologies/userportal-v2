// Read one milestone template plus its items.
//
// GET /api/admin/milestone-templates/:id
// Returns: { template, items[] }

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid template id' })
    }
    const client = await serverSupabaseClient(event)

    const { data: template, error: tErr } = await (client as any)
      .from('deal_milestone_templates')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (tErr) {
      logger.error(
        { err: tErr.message, op: 'milestone_templates.get', id },
        'milestone_templates_get_failed',
      )
      throw createError({ statusCode: 500, statusMessage: tErr.message })
    }
    if (!template) {
      throw createError({ statusCode: 404, statusMessage: 'Template not found' })
    }

    const { data: items, error: iErr } = await (client as any)
      .from('deal_milestone_template_items')
      .select('*')
      .eq('template_id', id)
      .order('sequence', { ascending: true })
    if (iErr) {
      logger.error(
        { err: iErr.message, op: 'milestone_templates.get_items', id },
        'milestone_templates_get_items_failed',
      )
      throw createError({ statusCode: 500, statusMessage: iErr.message })
    }

    return { template, items: items ?? [] }
  },
})
