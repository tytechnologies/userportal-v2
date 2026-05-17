// Admin: upsert the active owner statement policy.
//
// PUT /api/admin/property-owners/[id]/statement-policy
// Body: { cadence?, fire_day_of_period?, auto_issue?, next_run_at?, notes? }
//
// Mirror of the tenant-side endpoint. Atomically pauses any prior
// active policy and inserts the new shape. Defaults: monthly cadence,
// fire on day 1, auto_issue=false.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  cadence: z.enum(['monthly', 'quarterly']).default('monthly'),
  fire_day_of_period: z.number().int().min(1).max(28).default(1),
  auto_issue: z.boolean().default(false),
  next_run_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'next_run_at must be YYYY-MM-DD')
    .optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})

function defaultNextRunAt(cadence: 'monthly' | 'quarterly', fireDay: number): string {
  const now = new Date()
  let target: Date
  if (cadence === 'monthly') {
    target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  } else {
    const currentQuarter = Math.floor(now.getUTCMonth() / 3)
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

    const ownerId = getRouterParam(event, 'id')
    if (!ownerId || !/^[0-9a-f-]{36}$/i.test(ownerId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid owner id' })
    }

    const admin = getServerSupabaseAdmin()

    const { data: owner, error: ownerErr } = await (admin as any)
      .from('property_owners')
      .select('id')
      .eq('id', ownerId)
      .maybeSingle()
    if (ownerErr) {
      throw createError({ statusCode: 500, statusMessage: ownerErr.message })
    }
    if (!owner) {
      throw createError({ statusCode: 404, statusMessage: 'Owner not found' })
    }

    // Pause prior active policy.
    const { error: endErr } = await (admin as any)
      .from('owner_statement_policies')
      .update({ ended_at: new Date().toISOString(), status: 'paused' })
      .eq('property_owner_id', ownerId)
      .eq('status', 'active')
      .is('ended_at', null)
    if (endErr) {
      logger.error(
        {
          err: endErr.message,
          op: 'admin.owner_statement_policy.end_prior',
          property_owner_id: ownerId,
        },
        'owner_statement_policy_end_prior_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not retire prior policy',
      })
    }

    const nextRunAt = body.next_run_at ?? defaultNextRunAt(body.cadence!, body.fire_day_of_period!)

    const insertRow = {
      property_owner_id: ownerId,
      cadence: body.cadence,
      fire_day_of_period: body.fire_day_of_period,
      auto_issue: body.auto_issue,
      next_run_at: nextRunAt,
      notes: body.notes ?? null,
      created_by: user?.id ?? null,
    }

    const { data: created, error: insertErr } = await (admin as any)
      .from('owner_statement_policies')
      .insert(insertRow)
      .select('*')
      .single()
    if (insertErr) {
      logger.error(
        {
          err: insertErr.message,
          op: 'admin.owner_statement_policy.insert',
          property_owner_id: ownerId,
        },
        'owner_statement_policy_insert_failed',
      )
      const code = (insertErr as any).code as string | undefined
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: insertErr.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not save policy' })
    }

    await logActivity({
      event,
      action: 'owner_statement_policy.upserted',
      entity: 'property_owner' as any,
      entityId: ownerId,
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
