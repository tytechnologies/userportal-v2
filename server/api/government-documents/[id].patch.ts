// Update a government reference document. Admin-gated via RLS.
// File replacement happens via the dedicated /upload endpoint in a
// follow-up; this endpoint only mutates metadata.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20_000).nullable().optional(),
  category: z
    .enum(['capital_gains', 'transfer_tax', 'registration', 'tax_declaration', 'other'])
    .optional(),
  step_number: z.number().int().min(1).max(99).nullable().optional(),
  display_order: z.number().int().min(0).max(9999).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  checklist_items: z.array(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('government_documents')
      .update(body)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'gov_docs.update', id }, 'gov_docs_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Not found' })

    return data
  },
})
