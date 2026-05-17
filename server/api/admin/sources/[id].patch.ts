// Admin — edit a partner source.
//
// PATCH /api/admin/sources/:id
// Body: any subset of { display_name, base_url, enabled,
//                       staleness_ttl_hours, notes }
//
// Slug is intentionally NOT editable here — the slug is the partner-
// facing identifier and changing it would break their POST URL.
// Renaming a partner is a "rotate + create new + retire old" workflow.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.object({
  display_name:        z.string().trim().min(1).max(200).optional(),
  base_url:            z.string().trim().url().max(500).nullable().optional(),
  enabled:             z.boolean().optional(),
  staleness_ttl_hours: z.coerce.number().int().min(1).max(8760).optional(),
  notes:               z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const sourceId = Number(getRouterParam(event, 'id') || '0')
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid source id' })
    }

    const b = body as z.infer<typeof bodySchema>
    if (Object.keys(b).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const supabase = await serverSupabaseClient(event)
    const patch: Record<string, unknown> = { ...b, updated_at: new Date().toISOString() }

    const { data, error } = await (supabase as any)
      .from('listing_sources')
      .update(patch)
      .eq('id', sourceId)
      .select(
        'id, slug, display_name, base_url, enabled, staleness_ttl_hours, ' +
          'last_ingested_at, notes, created_at, updated_at',
      )
      .maybeSingle()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Source not found' })

    return { source: data }
  },
})
