// Create a milestone template.
//
// POST /api/admin/milestone-templates
// Body: { deal_type, name, description?, is_default?, active?, items?[] }
//
// When is_default=true the partial unique index enforces single
// default per deal_type â€” flipping the default requires deactivating
// (active=false) the prior default first.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const itemSchema = z.object({
  milestone_key: z.string().trim().min(1).max(80).regex(/^[a-z0-9_]+$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  sequence: z.number().int().min(0).max(10_000).optional(),
  required: z.boolean().optional(),
  default_due_offset_hours: z.number().int().min(0).max(24 * 365).nullable().optional(),
  policy: z.record(z.unknown()).optional(),
})

const bodySchema = z.object({
  deal_type: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  is_default: z.boolean().optional(),
  active: z.boolean().optional(),
  items: z.array(itemSchema).max(50).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data: tmpl, error } = await (client as any)
      .from('deal_milestone_templates')
      .insert({
        deal_type: body.deal_type,
        name: body.name,
        description: body.description ?? null,
        is_default: body.is_default ?? false,
        active: body.active ?? true,
        created_by: user.id,
      })
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'milestone_templates.create' },
        'milestone_templates_create_failed',
      )
      // 23505 from the partial unique index = another active default exists.
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage:
            `A default template already exists for deal_type='${body.deal_type}'. Deactivate or unset it first.`,
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Items are optional in the create call. Bulk insert for atomicity
    // â€” if any item violates UNIQUE(template, milestone_key) the whole
    // batch rolls back and the template stays without items (cleanup
    // is admin-driven).
    if (body.items && body.items.length > 0) {
      const itemRows = body.items.map((it) => ({
        template_id: tmpl.id,
        milestone_key: it.milestone_key,
        title: it.title,
        description: it.description ?? null,
        sequence: it.sequence ?? 0,
        required: it.required ?? true,
        default_due_offset_hours: it.default_due_offset_hours ?? null,
        policy: it.policy ?? {},
      }))
      const { error: itErr } = await (client as any)
        .from('deal_milestone_template_items')
        .insert(itemRows)
      if (itErr) {
        logger.error(
          { err: itErr.message, op: 'milestone_templates.create_items', templateId: tmpl.id },
          'milestone_templates_create_items_failed',
        )
        throw createError({ statusCode: 500, statusMessage: itErr.message })
      }
    }

    logActivity({
      event,
      action: 'admin.milestone_template_created',
      entity: 'deal',
      entityId: null,
      metadata: {
        template_id: tmpl.id,
        deal_type: body.deal_type,
        name: body.name,
        item_count: body.items?.length ?? 0,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestone_templates_create_activity_log_failed',
      )
    })

    return tmpl
  },
})
