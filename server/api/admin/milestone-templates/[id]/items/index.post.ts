// Add an item to a milestone template.
//
// POST /api/admin/milestone-templates/:id/items
// Body: TemplateItemInput

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  milestone_key: z.string().trim().min(1).max(80).regex(/^[a-z0-9_]+$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  sequence: z.number().int().min(0).max(10_000).optional(),
  required: z.boolean().optional(),
  default_due_offset_hours: z.number().int().min(0).max(24 * 365).nullable().optional(),
  policy: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const templateId = getRouterParam(event, 'id')
    if (!templateId || !/^[0-9a-f-]{36}$/i.test(templateId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid template id' })
    }
    const client = await serverSupabaseClient(event)

    const { data, error } = await (client as any)
      .from('deal_milestone_template_items')
      .insert({
        template_id: templateId,
        milestone_key: body.milestone_key,
        title: body.title,
        description: body.description ?? null,
        sequence: body.sequence ?? 0,
        required: body.required ?? true,
        default_due_offset_hours: body.default_due_offset_hours ?? null,
        policy: body.policy ?? {},
      })
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'milestone_templates.add_item', templateId },
        'milestone_templates_add_item_failed',
      )
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `Milestone key '${body.milestone_key}' already exists in this template`,
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'admin.milestone_template_item_added',
      entity: 'deal',
      entityId: null,
      metadata: { template_id: templateId, item_id: data.id, milestone_key: body.milestone_key },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestone_templates_add_item_activity_log_failed',
      )
    })

    return data
  },
})
