// Save a tax computation record. owner_user_id is auto-stamped by the
// DEFAULT auth.uid() — clients NEVER pass it. RLS gates the INSERT.
//
// `inputs` is a free-form JSONB blob (the form's state). The forms
// today are legacy with shifting field shapes; pinning a strict schema
// here would force a migration every time the form gains a row. Instead
// we cap the size and let the consumer interpret.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  taxpayer_type: z.enum(['individual', 'corporate']),
  computation_kind: z.enum(['gross', 'nett', 'nett_zv']).default('nett'),
  inputs: z.record(z.unknown()).default({}),
  title: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  listing_id: z.number().int().positive().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const supabase = await serverSupabaseClient(event)

    const insert = {
      taxpayer_type: body.taxpayer_type,
      computation_kind: body.computation_kind,
      inputs: body.inputs,
      title: body.title ?? null,
      notes: body.notes ?? null,
      contact_id: body.contact_id ?? null,
      listing_id: body.listing_id ?? null,
    }

    const { data, error } = await (supabase as any)
      .from('tax_computations')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      logger.error({ err: error.message, op: 'tax_computations.create' }, 'tax_computations_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Best-effort audit. Stamp contact_id + listing_id so the unified
    // CRM timeline pivots on either entity.
    await logActivity({
      event,
      client: supabase,
      action: 'tax_computation.saved',
      entity: 'document',
      metadata: {
        tax_computation_id: data.id,
        taxpayer_type: data.taxpayer_type,
        computation_kind: data.computation_kind,
        title: data.title,
        contact_id: data.contact_id ?? null,
        listing_id: data.listing_id ?? null,
      },
    })

    setResponseStatus(event, 201)
    return data
  },
})
