// GET /api/admin/ai-suggestions?status=pending&kind=...

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  status: z.enum(['pending', 'accepted', 'rejected', 'superseded', 'expired']).optional(),
  kind: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('ai_suggestions')
      .select(
        'id, kind, target_kind, target_id, suggested_payload, ' +
          'model_provider, model_name, model_run_id, prompt_version, confidence, ' +
          'status, reviewed_by, reviewed_at, accepted_payload, reject_reason, ' +
          'metadata, expires_at, created_at, updated_at',
      )
      .order('created_at', { ascending: false })
      .limit(query.limit ?? 200)
    if (query.status) q = q.eq('status', query.status)
    if (query.kind) q = q.eq('kind', query.kind)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
