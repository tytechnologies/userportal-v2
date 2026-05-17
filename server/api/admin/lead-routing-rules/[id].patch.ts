// Update a lead-routing rule.
//
// PATCH /api/admin/lead-routing-rules/[id]
// Body: any subset of the create body shape.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const criteriaSchema = z.object({
  property_type: z.union([z.string(), z.array(z.string())]).optional(),
  listing_kind: z.enum(['sale', 'rent', 'sale_or_rent']).optional(),
  city_id: z.union([z.number().int(), z.array(z.number().int())]).optional(),
  barangay_id: z.union([z.number().int(), z.array(z.number().int())]).optional(),
  min_price: z.number().nonnegative().optional(),
  max_price: z.number().nonnegative().optional(),
  source: z.union([z.string(), z.array(z.string())]).optional(),
  has_listing: z.boolean().optional(),
})

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
  criteria: criteriaSchema.optional(),
  action_kind: z.enum(['assign_user', 'round_robin_pool']).optional(),
  assign_user_id: z.string().uuid().nullable().optional(),
  pool_user_ids: z.array(z.string().uuid()).max(50).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid rule id' })
    }

    const admin = getServerSupabaseAdmin()

    const patch: Record<string, unknown> = {}
    for (const k of [
      'name',
      'description',
      'priority',
      'enabled',
      'criteria',
      'action_kind',
      'assign_user_id',
      'pool_user_ids',
      'notes',
    ] as const) {
      const v = (body as any)[k]
      if (v !== undefined) patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      return { id, updated: false }
    }

    const { data: updated, error } = await (admin as any)
      .from('lead_routing_rules')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'admin.lead_routing.patch', rule_id: id },
        'lead_routing_patch_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not update rule' })
    }

    await logActivity({
      event,
      action: 'lead_routing_rule.updated',
      entity: 'lead_routing_rule' as any,
      entityId: id,
      metadata: { changed_fields: Object.keys(patch) },
    })

    return { rule: updated }
  },
})
