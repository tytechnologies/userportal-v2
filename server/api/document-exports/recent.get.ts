// Recent DOCX/PDF exports across drafts the caller can read.
//
// GET /api/document-exports/recent?limit=20
//
// Returns each export hydrated with the parent draft's title + type
// so the panel renders meaningful rows. RLS on document_exports
// piggybacks on the parent draft visibility (see Phase-3 migration);
// orphaned exports get filtered out client-side as a defense-in-depth
// against RLS projection returning null on the join.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  format: z.enum(['docx', 'pdf']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    let sb: any = (supabase as any)
      .from('document_exports')
      .select(`
        id, draft_id, format, byte_length, generated_at, generated_by,
        draft:document_drafts (id, title, doc_type_key)
      `)
      .order('generated_at', { ascending: false })
      .limit(q.limit)
    if (q.format) sb = sb.eq('format', q.format)

    const { data, error } = await sb
    if (error) {
      logger.error({ err: error.message, op: 'document_exports.recent' }, 'doc_exports_recent_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: (data ?? []).filter((r: any) => r.draft) }
  },
})
