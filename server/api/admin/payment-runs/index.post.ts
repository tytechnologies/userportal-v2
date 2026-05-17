// POST /api/admin/payment-runs
// Body: { run_kind: 'rent' | 'dues', period_for: ISO date }
//
// Manually triggers a billing-generation run. The cron does this
// daily; this endpoint lets ops re-run for a missed day.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  run_kind: z.enum(['rent', 'dues']),
  period_for: z.string().date(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const client = await serverSupabaseClient(event)
    const rpc = body.run_kind === 'rent' ? 'generate_rent_charges' : 'generate_dues_charges'
    const { data, error } = await (client as any).rpc(rpc, {
      p_period_for: body.period_for,
    })
    if (error) {
      logger.error(
        { err: error.message, op: `payment_runs.${body.run_kind}` },
        'payment_runs_manual_failed',
      )
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }
    return data
  },
})
