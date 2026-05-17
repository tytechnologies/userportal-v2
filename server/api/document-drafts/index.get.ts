// List the caller's visible drafts. RLS scopes what comes back.
// Optional ?contact_id filter narrows to one contact's drafts.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  contact_id: z.coerce.number().int().positive().optional(),
  listing_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['draft', 'in_review', 'signed', 'archived']).optional(),
  /** Filter to drafts whose tags include this string (case-sensitive
   *  match — normalizeTags trims but preserves case). */
  tag: z.string().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const limit = (query as any).limit ?? 200
    const contactId = (query as any).contact_id as number | undefined
    const listingId = (query as any).listing_id as number | undefined
    const status = (query as any).status as string | undefined
    const tag = (query as any).tag as string | undefined

    let q = (supabase as any)
      .from('document_drafts')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (contactId !== undefined) q = q.eq('contact_id', contactId)
    if (listingId !== undefined) q = q.eq('listing_id', listingId)
    if (status !== undefined)    q = q.eq('status', status)
    // contains() generates `tags @> '{...}'` which uses the GIN index
    // added by 20260502000004.
    if (tag !== undefined)       q = q.contains('tags', [tag])

    const { data, error } = await q
    if (error) {
      logger.error({ err: error.message, op: 'document_drafts.list' }, 'document_drafts_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
