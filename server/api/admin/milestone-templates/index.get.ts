// List milestone templates.
//
// GET /api/admin/milestone-templates?deal_type=sale&active=1
// Returns: { items: DealMilestoneTemplate[] }
//
// Templates are platform-wide and SELECT-readable by every
// authenticated user; this endpoint is admin-namespaced because the
// management UI lives there.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  deal_type: z.string().trim().min(1).max(40).optional(),
  active: z.union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')]).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('deal_milestone_templates')
      .select(
        'id, deal_type, name, description, is_default, active, created_by, created_at, updated_at',
      )
      .order('deal_type', { ascending: true })
      .order('is_default', { ascending: false })
      .order('name', { ascending: true })

    if (query.deal_type) q = q.eq('deal_type', query.deal_type)
    if (query.active !== undefined) {
      const wantActive = query.active === '1' || query.active === 'true'
      q = q.eq('active', wantActive)
    }

    const { data, error } = await q
    if (error) {
      logger.error(
        { err: error.message, op: 'milestone_templates.list' },
        'milestone_templates_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
