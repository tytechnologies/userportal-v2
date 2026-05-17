// Create a new clause. Always lands in 'draft' status â€” approval is
// a separate transition handled by PATCH on the row. RLS already
// scopes writes to the `clauses.manage` permission.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  key:           z.string().trim().min(1).max(120),
  version:       z.number().int().min(1).default(1),
  doc_type_keys: z.array(z.string().min(1).max(80)).max(40).default([]),
  jurisdiction:  z.string().min(2).max(8).default('PH'),
  title:         z.string().trim().min(1).max(200),
  body:          z.string().trim().min(1).max(50_000),
  description:   z.string().trim().max(2000).nullable().optional(),
  placeholders:  z.array(z.string().min(1).max(80)).max(80).default([]),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const { data, error } = await (supabase as any)
      .from('clause_library')
      .insert({
        key:           body.key,
        version:       body.version,
        status:        'draft',
        doc_type_keys: body.doc_type_keys,
        jurisdiction:  body.jurisdiction,
        title:         body.title,
        body:          body.body,
        description:   body.description ?? null,
        placeholders:  body.placeholders,
        created_by:    user?.id ?? null,
      })
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'clauses.create' }, 'clauses_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    setResponseStatus(event, 201)
    return data
  },
})
