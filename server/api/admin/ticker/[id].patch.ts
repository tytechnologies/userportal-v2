// Admin — update a ticker message (any subset of editable fields).
//
// PATCH /api/admin/ticker/:id

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

const KINDS = [
  'static',
  'new_listings_recent',
  'active_agents',
  'total_listings_online',
  'city_pulse',
] as const

const TONES = [
  'success', 'warning', 'destructive', 'info', 'primary', 'neutral',
] as const

const bodySchema = z.object({
  kind:          z.enum(KINDS).optional(),
  label:         z.string().trim().min(1).max(240).optional(),
  tone:          z.enum(TONES).optional(),
  source_config: z.record(z.unknown()).optional(),
  link_url:      z.string().trim().regex(/^(\/|https?:\/\/)/).max(500).nullable().optional(),
  priority:      z.coerce.number().int().min(0).max(10_000).optional(),
  enabled:       z.boolean().optional(),
  notes:         z.string().trim().max(2_000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid ticker id' })
    }
    const b = body as z.infer<typeof bodySchema>
    if (Object.keys(b).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('marketing_ticker_messages')
      .update(b)
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Ticker not found' })
    return data
  },
})
