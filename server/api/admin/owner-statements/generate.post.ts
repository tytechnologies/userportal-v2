// Admin: manually trigger the owner-statement aggregation cron.
//
// POST /api/admin/owner-statements/generate
// Body (optional): { period_for?: 'YYYY-MM-DD' }
//
// Idempotent thanks to the cron's SELECT-before-INSERT against
// (owner_id, period_start, period_end).

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  period_for: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'period_for must be YYYY-MM-DD')
    .optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const periodFor =
      body.period_for ?? new Date().toISOString().slice(0, 10)

    const admin = getServerSupabaseAdmin()
    const { data, error } = await (admin as any).rpc(
      'generate_owner_statements',
      { p_today: periodFor },
    )

    if (error) {
      logger.error(
        {
          err: error.message,
          op: 'admin.owner_statements.generate',
          period_for: periodFor,
        },
        'owner_statements_generate_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Generation failed' })
    }

    const result = data as {
      run_id: string | null
      policies_processed: number
      statements_created: number
      skipped: number
      errors: number
    }

    await logActivity({
      event,
      action: 'owner_statements.generated',
      entity: 'payment_run' as any,
      entityId: result.run_id ?? '00000000-0000-0000-0000-000000000000',
      metadata: {
        period_for: periodFor,
        policies_processed: result.policies_processed,
        statements_created: result.statements_created,
        skipped: result.skipped,
        errors: result.errors,
        triggered: 'manual',
      },
    })

    return result
  },
})
