// Update a template definition. Partial — only the body's set fields
// are written. RLS rejects the operation unless the caller has
// templates.manage.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  width: z.number().int().min(100).max(5000).optional(),
  height: z.number().int().min(100).max(7000).optional(),
  fields: z.array(z.record(z.unknown())).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing template id' })

    const supabase = await serverSupabaseClient(event)
    const update: Record<string, unknown> = {}
    for (const k of ['name', 'description', 'width', 'height', 'fields', 'status'] as const) {
      if (body[k] !== undefined) update[k] = body[k] as unknown
    }
    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const { data, error } = await (supabase as any)
      .from('document_template_definitions')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'template_defs.update', id }, 'template_defs_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Template not found or not editable' })
    return data
  },
})
