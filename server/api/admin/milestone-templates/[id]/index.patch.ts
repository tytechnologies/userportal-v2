// Update template metadata. Items are managed via
// /api/admin/milestone-templates/:id/items/*.
//
// PATCH /api/admin/milestone-templates/:id
// Body: { name?, description?, is_default?, active?, deal_type? }

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z
  .object({
    deal_type: z.string().trim().min(1).max(40).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    is_default: z.boolean().optional(),
    active: z.boolean().optional(),
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
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid template id' })
    }
    const client = await serverSupabaseClient(event)

    const { data, error } = await (client as any)
      .from('deal_milestone_templates')
      .update(body)
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'milestone_templates.patch', id },
        'milestone_templates_patch_failed',
      )
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage:
            'Another template is already the active default for this deal_type. Deactivate it first.',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Template not found' })
    }

    logActivity({
      event,
      action: 'admin.milestone_template_updated',
      entity: 'deal',
      entityId: null,
      metadata: { template_id: id, changed: Object.keys(body) },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestone_templates_patch_activity_log_failed',
      )
    })

    return data
  },
})
