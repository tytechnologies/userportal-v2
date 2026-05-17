// Create a lead-routing rule.
//
// POST /api/admin/lead-routing-rules
// Body: { name, description?, priority?, enabled?, criteria, action_kind,
//          assign_user_id?, pool_user_ids?, notes? }

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

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    priority: z.number().int().min(0).max(10000).default(100),
    enabled: z.boolean().default(true),
    criteria: criteriaSchema.default({}),
    action_kind: z.enum(['assign_user', 'round_robin_pool']),
    assign_user_id: z.string().uuid().nullable().optional(),
    pool_user_ids: z.array(z.string().uuid()).max(50).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (b) =>
      (b.action_kind === 'assign_user' && !!b.assign_user_id) ||
      (b.action_kind === 'round_robin_pool' &&
        Array.isArray(b.pool_user_ids) &&
        b.pool_user_ids.length > 0),
    { message: 'assign_user requires assign_user_id; round_robin_pool requires non-empty pool_user_ids' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()

    const insertRow = {
      name: body.name,
      description: body.description ?? null,
      priority: body.priority,
      enabled: body.enabled,
      criteria: body.criteria,
      action_kind: body.action_kind,
      assign_user_id: body.action_kind === 'assign_user' ? body.assign_user_id : null,
      pool_user_ids: body.action_kind === 'round_robin_pool' ? body.pool_user_ids : null,
      notes: body.notes ?? null,
      created_by: user?.id ?? null,
    }

    const { data: created, error } = await (admin as any)
      .from('lead_routing_rules')
      .insert(insertRow)
      .select('*')
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'admin.lead_routing.create' },
        'lead_routing_create_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not create rule' })
    }

    await logActivity({
      event,
      action: 'lead_routing_rule.created',
      entity: 'lead_routing_rule' as any,
      entityId: created.id,
      metadata: {
        name: body.name,
        priority: body.priority,
        action_kind: body.action_kind,
      },
    })

    return { rule: created }
  },
})
