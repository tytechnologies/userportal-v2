// List tax computation records visible to the caller. RLS scopes
// to own/team/all per their tax_computations.read.* permissions.
//
// Filters:
//   - mine        ?mine=true → only records owned by the caller
//   - listing_id  ?listing_id=42
//   - contact_id  ?contact_id=42
//   - taxpayer_type  ?taxpayer_type=individual|corporate
//
// Order: created_at DESC (newest first — matches the agent's
// inbox-style mental model).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  mine: z.coerce.boolean().optional(),
  listing_id: z.coerce.number().int().positive().optional(),
  contact_id: z.coerce.number().int().positive().optional(),
  taxpayer_type: z.enum(['individual', 'corporate']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query, user }) => {
    const supabase = await serverSupabaseClient(event)
    const q = query as z.infer<typeof querySchema>
    const page = q.page
    const pageSize = q.page_size

    let sb: any = (supabase as any)
      .from('tax_computations')
      .select(
        'id, owner_user_id, contact_id, listing_id, taxpayer_type, ' +
        'computation_kind, title, notes, created_at, updated_at, ' +
        'owner:profiles!owner_user_id (id, full_name, avatar_url)',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })

    if (q.mine) sb = sb.eq('owner_user_id', user!.id)
    if (q.listing_id) sb = sb.eq('listing_id', q.listing_id)
    if (q.contact_id) sb = sb.eq('contact_id', q.contact_id)
    if (q.taxpayer_type) sb = sb.eq('taxpayer_type', q.taxpayer_type)

    const from = (page - 1) * pageSize
    const to = from + pageSize - 1
    sb = sb.range(from, to)

    const { data, error, count } = await sb
    if (error) {
      logger.error({ err: error.message, op: 'tax_computations.list' }, 'tax_computations_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      data: data ?? [],
      total: count ?? 0,
      page,
      page_size: pageSize,
      total_pages: count ? Math.ceil(count / pageSize) : 0,
    }
  },
})
