// Search staff (profiles) for the reviewer picker on the approvals
// panel. RLS-scoped via the profiles table — callers see profiles
// they can read, which is typically org-scoped or platform-wide
// depending on role.
//
// GET /api/staff/search?q=alice&limit=8

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  q:     z.string().trim().min(1).max(80),
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    // Match against full_name and email (case-insensitive). If the
    // platform later adds a slug, include it here.
    const term = q.q.replace(/[%_]/g, '\\$&')
    const { data, error } = await (supabase as any)
      .from('profiles')
      .select('id, full_name, email, avatar_url')
      .or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)
      .order('full_name', { ascending: true })
      .limit(q.limit)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
