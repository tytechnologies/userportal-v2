// Admin: upsert the active tenant statement policy for a lease.
//
// PUT /api/admin/leases/[id]/tenant-statement-policy
// Body: { cadence?, fire_day_of_period?, auto_issue?, next_run_at?, notes? }
//
// Atomically pauses any prior active policy and inserts the new shape.
// Defaults: cadence='monthly', fire_day_of_period=1, auto_issue=false.
// next_run_at defaults to the start of the next calendar period
// (next month / next quarter) so the first statement covers the
// just-completed period.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  cadence: z.enum(['monthly', 'quarterly']).default('monthly'),
  fire_day_of_period: z.number().int().min(1).max(28).default(1),
  auto_issue: z.boolean().default(false),
  // Optional explicit next_run_at; if omitted, server computes a sensible default.
  next_run_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'next_run_at must be YYYY-MM-DD')
    .optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})

function defaultNextRunAt(cadence: 'monthly' | 'quarterly', fireDay: number): string {
  // Compute the first day of the next calendar period, then offset by
  // (fireDay - 1) so a fire_day=1 fires on the 1st, fire_day=5 on the
  // 5th, etc.
  const now = new Date()
  let target: Date
  if (cadence === 'monthly') {
    target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  } else {
    const currentQuarter = Math.floor(now.getUTCMonth() / 3) // 0..3
    target = new Date(Date.UTC(now.getUTCFullYear(), (currentQuarter + 1) * 3, 1))
  }
  target.setUTCDate(target.getUTCDate() + (fireDay - 1))
  return target.toISOString().slice(0, 10)
}

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

    // Pause any prior active policy.
    const { error: endErr } = await (admin as any)
      .from('tenant_statement_policies')
      .update({ ended_at: new Date().toISOString(), status: 'paused' })
      .eq('lease_id', leaseId)
      .eq('status', 'active')
      .is('ended_at', null)
    if (endErr) {
      logger.error(
        {
          err: endErr.message,
          op: 'admin.tenant_statement_policy.end_prior',
          lease_id: leaseId,
        },
        'tenant_statement_policy_end_prior_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not retire prior policy',
      })
    }

    const nextRunAt = body.next_run_at ?? defaultNextRunAt(body.cadence!, body.fire_day_of_period!)

    const insertRow = {
      lease_id: leaseId,
      cadence: body.cadence,
      fire_day_of_period: body.fire_day_of_period,
      auto_issue: body.auto_issue,
      next_run_at: nextRunAt,
      notes: body.notes ?? null,
      created_by: user?.id ?? null,
    }

    const { data: created, error: insertErr } = await (admin as any)
      .from('tenant_statement_policies')
      .insert(insertRow)
      .select('*')
      .single()
    if (insertErr) {
      logger.error(
        {
          err: insertErr.message,
          op: 'admin.tenant_statement_policy.insert',
          lease_id: leaseId,
        },
        'tenant_statement_policy_insert_failed',
      )
      const code = (insertErr as any).code as string | undefined
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: insertErr.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not save policy' })
    }

    await logActivity({
      event,
      action: 'tenant_statement_policy.upserted',
      entity: 'lease' as any,
      entityId: leaseId,
      metadata: {
        policy_id: created.id,
        cadence: body.cadence,
        fire_day_of_period: body.fire_day_of_period,
        auto_issue: body.auto_issue,
        next_run_at: nextRunAt,
      },
    })

    return { policy: created }
  },
})
