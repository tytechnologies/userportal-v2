// Lightweight profile search for typeahead pickers (deal participants,
// task assignment, etc).
//
// GET /api/profiles/search?q=maria&limit=8
// Auth: required. RLS already lets every authenticated user read every
//       profile (mig 20260429000001 line 113-116) so no extra gate.
//
// Returns id + full_name + email + avatar_url. Capped at 20 rows.
// Search matches on full_name OR email (ilike).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  q:     z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)

    // ilike escape for `,%_` is unnecessary at this length; the worst
    // a malicious user can do is broaden their own search (which they
    // can already do via direct PostgREST access).
    const term = `%${q.q.replace(/[,%_]/g, ' ')}%`

    const { data, error } = await (supabase as any)
      .from('profiles')
      .select('id, full_name, email, avatar_url')
      .or(`full_name.ilike.${term},email.ilike.${term}`)
      .order('full_name', { ascending: true, nullsFirst: false })
      .limit(q.limit)

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { items: data ?? [] }
  },
})
