// List listing shares. RLS lets the caller see shares they own, are
// recipient of, or any if listings.read.all.
//
// Filters:
//   - listing_id   ?listing_id=42       — all shares on one listing
//   - direction    ?direction=incoming  — only shares where recipient = me
//                  ?direction=outgoing  — only shares I created
//   - status       open | pending | accepted | revoked
//
// Ordered created_at DESC.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  listing_id: z.coerce.number().int().positive().optional(),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  status: z.enum(['pending', 'accepted', 'revoked']).optional(),
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
      .from('listing_shares')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (q.listing_id) sb = sb.eq('listing_id', q.listing_id)
    if (q.status) sb = sb.eq('status', q.status)
    if (q.direction === 'incoming') sb = sb.eq('shared_with_user_id', user!.id)
    if (q.direction === 'outgoing') sb = sb.eq('shared_by_user_id', user!.id)

    const from = (page - 1) * pageSize
    const to = from + pageSize - 1
    sb = sb.range(from, to)

    const { data, error, count } = await sb
    if (error) {
      logger.error({ err: error.message, op: 'listing_shares.list' }, 'listing_shares_list_failed')
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
