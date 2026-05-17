// Pipeline recommendations â€” deterministic next-action hints.
//
// GET /api/automation/recommendations?mine=true&deal_id=
// Auth: required.
//
// Reads public.pipeline_recommendations. Each row has a stable
// rule_key + a structured suggested_action so the UI can render an
// "Apply" button alongside the suggestion (e.g., advance stage to
// negotiating).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'

const querySchema = z.object({
  mine: z.coerce.boolean().optional(),
  deal_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    // Same default-to-mine pattern as /api/automation/pipeline-alerts:
    // non-admins shouldn't see platform-wide recommendations they
    // can't act on.
    let isAdmin = false
    try {
      const { data, error } = await (supabase as any).rpc('has_permission', {
        permission_to_check: 'admin.access',
      })
      if (!error) isAdmin = data === true
    } catch {
      isAdmin = false
    }
    const effectiveMine =
      q.mine !== undefined ? q.mine : !isAdmin

    let req: any = (supabase as any)
      .from('pipeline_recommendations')
      .select('deal_id, listing_id, buyer_agent_user_id, rule_key, title, detail, suggested_action')
      .limit(q.limit)

    if (effectiveMine && user?.id) req = req.eq('buyer_agent_user_id', user.id)
    if (q.deal_id) req = req.eq('deal_id', q.deal_id)

    const { data, error } = await req
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { data: data ?? [] }
  },
})
