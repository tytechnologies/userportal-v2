// List clauses. RLS exposes approved clauses to all authenticated
// users; admins additionally see drafts and deprecated.
//
// Filters:
//   - doc_type — narrow to clauses applicable to a specific doc-type.
//                Note: a clause with empty doc_type_keys applies to all,
//                so the client filters that side too.
//   - status   — admin-only filter to inspect drafts.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  doc_type: z.string().min(1).max(80).optional(),
  status:   z.enum(['draft','approved','deprecated']).optional(),
  limit:    z.coerce.number().int().min(1).max(500).default(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    let sb: any = (supabase as any)
      .from('clause_library')
      .select('*')
      .order('title', { ascending: true })
      .limit(q.limit)

    if (q.status) sb = sb.eq('status', q.status)
    if (q.doc_type) {
      // Either applies to all (empty array) or includes this doc_type.
      // PostgREST array contains: cs.{val}; we union with array_length=0.
      sb = sb.or(`doc_type_keys.cs.{${q.doc_type}},doc_type_keys.eq.{}`)
    }

    const { data, error } = await sb
    if (error) {
      logger.error({ err: error.message, op: 'clauses.list' }, 'clauses_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
