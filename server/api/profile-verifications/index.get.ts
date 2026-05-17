// List verification requests visible to the caller.
//
// RLS scopes the result set:
//   - agents see their own rows only
//   - admins (users.manage) see all rows
// No special filter logic required server-side beyond standard pagination
// and an optional status filter for the admin queue UI.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { paginationQueryFields } from '~~/server/utils/pagination'

const querySchema = z.object({
  ...paginationQueryFields,
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  profile_id: z.string().uuid().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    let sb: any = (supabase as any)
      .from('profile_verifications')
      .select('*', { count: 'exact' })
      // Pending first for the admin queue UX, then by submission age.
      .order('status', { ascending: true })
      .order('submitted_at', { ascending: false })

    if (q.status) sb = sb.eq('status', q.status)
    if (q.profile_id) sb = sb.eq('profile_id', q.profile_id)

    const from = (q.page - 1) * q.page_size
    sb = sb.range(from, from + q.page_size - 1)

    const { data, error, count } = await sb
    if (error) {
      logger.error(
        { err: error.message, op: 'verifications.list' },
        'verifications_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      data: data ?? [],
      total: count ?? 0,
      page: q.page,
      page_size: q.page_size,
      total_pages: count ? Math.ceil(count / q.page_size) : 0,
    }
  },
})
