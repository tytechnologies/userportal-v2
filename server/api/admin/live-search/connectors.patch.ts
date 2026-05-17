// Admin — toggle / tune a source_connector row.
//
// PATCH /api/admin/live-search/connectors
// Body: { slug, enabled?, trust_score?, daily_budget?, default_ttl_seconds?,
//         domain_allowlist?, config?, notes? }
//
// Auth: admin.access via RLS on source_connectors (admin all policy).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const bodySchema = z.object({
  slug: z.string().min(1).max(80),
  enabled: z.boolean().optional(),
  trust_score: z.coerce.number().int().min(0).max(100).optional(),
  daily_budget: z.coerce.number().int().min(0).optional(),
  default_ttl_seconds: z.coerce.number().int().min(60).max(604800).optional(),
  domain_allowlist: z.array(z.string()).nullable().optional(),
  config: z.record(z.string(), z.any()).optional(),
  notes: z.string().max(1000).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Invalid body',
      data: { issues: parsed.error.issues },
    })
  }
  const { slug, ...patch } = parsed.data
  if (Object.keys(patch).length === 0) {
    throw createError({ statusCode: 422, statusMessage: 'No fields to update' })
  }

  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('source_connectors')
    .update(patch as any)
    .eq('slug', slug)
    .select()
    .maybeSingle()
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'Connector not found' })
  }
  return { ok: true, connector: data }
})
