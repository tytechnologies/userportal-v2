// Update a tax computation record. Most fields are immutable post-save
// (taxpayer_type, computation_kind, inputs — those define what the
// record IS); the editable surface is title + notes + cross-entity
// links + the inputs themselves if the user wants to revise.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  taxpayer_type: z.enum(['individual', 'corporate']).optional(),
  computation_kind: z.enum(['gross', 'nett', 'nett_zv']).optional(),
  inputs: z.record(z.unknown()).optional(),
  title: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  listing_id: z.number().int().positive().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('tax_computations')
      .update(body)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'tax_computations.update', id }, 'tax_computations_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Tax computation not found' })

    return data
  },
})
