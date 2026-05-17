// Create a new template definition. Admin-only via RLS
// (templates.manage). The client picks the slug-style id; we sanitize
// to be safe.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, {
    message: 'id must be snake_case (lowercase letters, digits, underscores)',
  }),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  width: z.number().int().min(100).max(5000).default(816),
  height: z.number().int().min(100).max(7000).default(1056),
  fields: z.array(z.record(z.unknown())).default([]),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('document_template_definitions')
      .insert({
        id: body.id,
        name: body.name,
        description: body.description ?? null,
        width: body.width,
        height: body.height,
        fields: body.fields,
        status: body.status,
        created_by: user?.id ?? null,
      })
      .select('*')
      .single()

    if (error) {
      // 23505 = unique_violation (id already exists). Surface as 409.
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `A template with id "${body.id}" already exists.`,
        })
      }
      logger.error({ err: error.message, op: 'template_defs.create' }, 'template_defs_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    setResponseStatus(event, 201)
    return data
  },
})
