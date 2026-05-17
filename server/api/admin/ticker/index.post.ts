// Admin — create a ticker message.
//
// POST /api/admin/ticker
// Body: { kind, label, tone?, source_config?, link_url?, priority?, enabled?, notes? }

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'

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
  kind:          z.enum(KINDS),
  label:         z.string().trim().min(1).max(240),
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
    const b = body as z.infer<typeof bodySchema>

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const { data, error } = await (supabase as any)
      .from('marketing_ticker_messages')
      .insert({
        kind:          b.kind,
        label:         b.label,
        tone:          b.tone ?? 'neutral',
        source_config: b.source_config ?? {},
        link_url:      b.link_url ?? null,
        priority:      b.priority ?? 100,
        enabled:       b.enabled ?? true,
        notes:         b.notes ?? null,
        created_by:    user?.id ?? null,
      })
      .select(
        'id, kind, label, source_config, tone, link_url, priority, enabled, ' +
          'notes, created_by, created_at, updated_at',
      )
      .single()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    setResponseStatus(event, 201)
    return data
  },
})
