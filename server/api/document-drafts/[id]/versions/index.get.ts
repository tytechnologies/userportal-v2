// List all versions of a draft, newest first. Read-through to the
// existing draft RLS via FK constraint.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_versions')
      .select(`
        id, draft_id, version_number, snapshot_body, label, created_at,
        created_by:profiles!document_versions_created_by_fkey (id, full_name, avatar_url)
      `)
      .eq('draft_id', id)
      .order('version_number', { ascending: false })
      .limit(q.limit)
    if (error) {
      logger.error({ err: error.message, op: 'doc_versions.list' }, 'doc_versions_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
