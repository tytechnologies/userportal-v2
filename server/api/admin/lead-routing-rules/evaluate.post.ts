// Preview which routing rule would match a hypothetical inquiry.
//
// POST /api/admin/lead-routing-rules/evaluate
// Body: { listing_id?: number, source?: string }
//
// Wraps the evaluate_lead_routing() RPC. Used by the admin rule
// editor to show "this rule would catch this inquiry" while building
// rule sets.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  listing_id: z.number().int().positive().nullable().optional(),
  source: z.string().trim().min(1).max(80).default('website'),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()
    const { data, error } = await (admin as any).rpc('evaluate_lead_routing', {
      p_listing_id: body.listing_id ?? null,
      p_source: body.source,
    })

    if (error) {
      logger.error(
        { err: error.message, op: 'admin.lead_routing.evaluate' },
        'lead_routing_evaluate_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Evaluation failed' })
    }

    return data
  },
})
