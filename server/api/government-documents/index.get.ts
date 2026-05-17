// List published government reference documents. RLS lets anon +
// every authenticated user read PUBLISHED rows; admins (gov_docs.write)
// also see drafts + archived.
//
// Filters:
//   - category   ?category=capital_gains|transfer_tax|registration|tax_declaration|other
//   - status     ?status=draft|published|archived (admin-only effect)
//   - search     ?search=tct  (substring on title or description)
//
// Order: category ASC, display_order ASC, step_number ASC NULLS LAST.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedUrlForS3Key } from '~~/server/utils/s3-signed-url'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  category: z
    .enum(['capital_gains', 'transfer_tax', 'registration', 'tax_declaration', 'other'])
    .optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  search: z.string().max(200).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const q = query as z.infer<typeof querySchema>

    let sb: any = (supabase as any)
      .from('government_documents')
      .select(
        'id, title, description, category, step_number, display_order, ' +
        's3_key, file_name, file_format, external_url, checklist_items, status, ' +
        'created_at, updated_at',
      )
      .order('category', { ascending: true })
      .order('display_order', { ascending: true })
      .order('step_number', { ascending: true, nullsFirst: false })

    if (q.category) sb = sb.eq('category', q.category)
    if (q.status) sb = sb.eq('status', q.status)
    if (q.search && q.search.trim()) {
      const safe = q.search.replace(/[%,()*]/g, '').trim()
      sb = sb.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`)
    }

    const { data, error } = await sb
    if (error) {
      logger.error({ err: error.message, op: 'gov_docs.list' }, 'gov_docs_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Sign each S3 key so the page can render direct download links.
    // `display_url` is the unified field clients should use: prefer a
    // freshly-signed S3 URL, fall back to the static external_url
    // (legacy public/img/documents/* paths). Empty string when neither
    // is present so the UI can branch on truthiness.
    const items = await Promise.all(
      (data ?? []).map(async (row: any) => {
        const signed_url = row.s3_key
          ? await getSignedUrlForS3Key(row.s3_key).catch(() => '')
          : ''
        const display_url = signed_url || row.external_url || ''
        return { ...row, signed_url, display_url }
      }),
    )

    return { data: items, total: items.length }
  },
})
