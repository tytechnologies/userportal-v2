// Admin: upsert the active late-fee policy for a lease.
//
// PUT /api/admin/leases/[id]/late-fee-policy
// Body: late-fee policy fields (validated below).
//
// Atomically ends any prior active policy on this lease (the
// one-active-per-lease partial UNIQUE would otherwise reject the
// insert) and creates a fresh row with the new shape. Returns the new
// row.
//
// To OPT OUT of late fees: DELETE this same route â€” clears the active
// policy without inserting a replacement.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z
  .object({
    currency: z.string().trim().length(3).default('PHP'),
    grace_days: z.number().int().min(0).max(90).default(5),
    fee_kind: z.enum(['flat', 'percent_of_balance', 'escalating']),
    flat_amount_minor: z.number().int().min(0).nullable().optional(),
    percent_value: z.number().min(0.001).max(100).nullable().optional(),
    cap_minor: z.number().int().min(1).nullable().optional(),
    recurrence_kind: z.enum(['once', 'recurring']).default('once'),
    recurrence_days: z.number().int().min(1).max(90).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  // Cross-field consistency mirrors the table-level CHECKs so the API
  // returns a clean 422 instead of bouncing off a constraint violation.
  .refine(
    (b) =>
      (b.fee_kind === 'percent_of_balance' && b.percent_value != null) ||
      ((b.fee_kind === 'flat' || b.fee_kind === 'escalating') && b.flat_amount_minor != null),
    { message: 'fee_kind and amount column are inconsistent' },
  )
  .refine(
    (b) => b.recurrence_kind === 'once' || b.recurrence_days != null,
    { message: 'recurring policies require recurrence_days' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    await requireRole(event, 'manager')

    const leaseId = getRouterParam(event, 'id')
    if (!leaseId || !/^[0-9a-f-]{36}$/i.test(leaseId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }

    const admin = getServerSupabaseAdmin()

    // Verify the lease exists. We don't check status â€” operators may
    // legitimately attach a policy to a draft / pending_signature lease
    // before activation; the cron only assesses past_due charges, which
    // can't exist until the lease is active anyway.
    const { data: lease, error: leaseErr } = await (admin as any)
      .from('leases')
      .select('id, status')
      .eq('id', leaseId)
      .maybeSingle()
    if (leaseErr) {
      throw createError({ statusCode: 500, statusMessage: leaseErr.message })
    }
    if (!lease) {
      throw createError({ statusCode: 404, statusMessage: 'Lease not found' })
    }

    // Phase 1: end any prior active policy. Idempotent on no-op.
    const { error: endErr } = await (admin as any)
      .from('late_fee_policies')
      .update({ ended_at: new Date().toISOString(), status: 'paused' })
      .eq('lease_id', leaseId)
      .eq('status', 'active')
      .is('ended_at', null)
    if (endErr) {
      logger.error(
        { err: endErr.message, op: 'admin.late_fee_policy.end_prior', lease_id: leaseId },
        'late_fee_policy_end_prior_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Could not retire prior policy' })
    }

    // Phase 2: insert the new policy.
    const insertRow = {
      lease_id: leaseId,
      currency: body.currency,
      grace_days: body.grace_days,
      fee_kind: body.fee_kind,
      flat_amount_minor: body.flat_amount_minor ?? null,
      percent_value: body.percent_value ?? null,
      cap_minor: body.cap_minor ?? null,
      recurrence_kind: body.recurrence_kind,
      recurrence_days: body.recurrence_days ?? null,
      notes: body.notes ?? null,
      created_by: user?.id ?? null,
    }

    const { data: created, error: insertErr } = await (admin as any)
      .from('late_fee_policies')
      .insert(insertRow)
      .select('*')
      .single()
    if (insertErr) {
      logger.error(
        { err: insertErr.message, op: 'admin.late_fee_policy.insert', lease_id: leaseId },
        'late_fee_policy_insert_failed',
      )
      // Surface CHECK violations as 422 so the operator UI can show the
      // friendly message rather than a generic 500.
      const code = (insertErr as any).code as string | undefined
      if (code === '23514') {
        throw createError({
          statusCode: 422,
          statusMessage: insertErr.message,
        })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not save policy' })
    }

    await logActivity({
      event,
      action: 'late_fee_policy.upserted',
      entity: 'lease' as any,
      entityId: leaseId,
      metadata: {
        policy_id: created.id,
        fee_kind: body.fee_kind,
        flat_amount_minor: body.flat_amount_minor,
        percent_value: body.percent_value,
        cap_minor: body.cap_minor,
        recurrence_kind: body.recurrence_kind,
      },
    })

    return { policy: created }
  },
})
