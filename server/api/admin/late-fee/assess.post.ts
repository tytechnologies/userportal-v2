// Admin: manually trigger the late-fee assessment cron.
//
// POST /api/admin/late-fee/assess
// Body (optional): { period_for?: 'YYYY-MM-DD' } â€” defaults to today.
//
// Useful when:
//   - Operator just attached a policy to a lease with overdue charges
//     and wants the late fees applied now rather than on tomorrow's
//     04:00 UTC cron run.
//   - Recovery after a missed cron (admin reviews payment_runs to
//     find skipped days).
//
// The RPC is idempotent thanks to late_fee_assessments
// UNIQUE (source_charge_id, recurrence_index), so re-running is safe.

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
      'assess_past_due_charges',
      { p_today: periodFor },
    )

    if (error) {
      logger.error(
        { err: error.message, op: 'admin.late_fee.assess', period_for: periodFor },
        'late_fee_assess_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Assessment failed' })
    }

    const result = data as {
      run_id: string
      charges_flipped_to_past_due: number
      late_fees_created: number
      late_fees_skipped: number
      errors: number
    }

    await logActivity({
      event,
      action: 'late_fee.assessed',
      entity: 'payment_run' as any,
      entityId: result.run_id,
      metadata: {
        period_for: periodFor,
        charges_flipped: result.charges_flipped_to_past_due,
        late_fees_created: result.late_fees_created,
        late_fees_skipped: result.late_fees_skipped,
        errors: result.errors,
        triggered: 'manual',
      },
    })

    return result
  },
})
