// List template definitions. RLS scopes what comes back: regular
// users see published only; admins (templates.manage) see everything.
//
// Optional ?status=draft|published|archived narrows the set; default
// returns whatever RLS allows.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const limit = (query as any).limit ?? 200
    const status = (query as any).status

    let q = (supabase as any)
      .from('document_template_definitions')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (status) q = q.eq('status', status)

    const { data, error } = await q
    if (error) {
      logger.error({ err: error.message, op: 'template_defs.list' }, 'template_defs_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
