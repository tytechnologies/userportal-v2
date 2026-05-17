// Update one milestone template item.
//
// PATCH /api/admin/milestone-templates/:id/items/:itemId

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z
  .object({
    milestone_key: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    sequence: z.number().int().min(0).max(10_000).optional(),
    required: z.boolean().optional(),
    default_due_offset_hours: z.number().int().min(0).max(24 * 365).nullable().optional(),
    policy: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine(
    (b) => Object.keys(b).length > 0,
    { message: 'At least one updatable field is required' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const templateId = getRouterParam(event, 'id')
    const itemId = getRouterParam(event, 'itemId')
    if (!templateId || !/^[0-9a-f-]{36}$/i.test(templateId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid template id' })
    }
    if (!itemId || !/^[0-9a-f-]{36}$/i.test(itemId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid item id' })
    }

    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('deal_milestone_template_items')
      .update(body)
      .eq('id', itemId)
      .eq('template_id', templateId)
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'milestone_templates.patch_item', templateId, itemId },
        'milestone_templates_patch_item_failed',
      )
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'milestone_key collides with another item in this template',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Template item not found' })
    }

    logActivity({
      event,
      action: 'admin.milestone_template_item_updated',
      entity: 'deal',
      entityId: null,
      metadata: { template_id: templateId, item_id: itemId, changed: Object.keys(body) },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestone_templates_patch_item_activity_log_failed',
      )
    })

    return data
  },
})
