// Update a market watch's alert_types or label.
//
// PATCH /api/me/watches/:id
// Body: { alert_types?, label? }

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'

const ALERT_TYPES = [
  'new_listing_in_watch',
  'verified_listing',
  'hot_area',
  'fast_moving_inventory',
  'trusted_broker_listed',
] as const

const UUID_RE = /^[0-9a-f-]{36}$/i

const bodySchema = z.object({
  alert_types: z.array(z.enum(ALERT_TYPES)).min(1).optional(),
  label:       z.string().trim().max(120).nullable().optional(),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const b = body as z.infer<typeof bodySchema>
    if (Object.keys(b).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid watch id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (supabase as any)
      .from('market_watches')
      .update(b)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, target_type, target_id, alert_types, label')
      .maybeSingle()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Watch not found' })

    return { watch: data }
  },
})
