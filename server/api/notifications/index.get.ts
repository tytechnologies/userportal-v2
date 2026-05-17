// List notifications for the caller. RLS returns recipient_user_id =
// auth.uid() (or all for users.manage admins).
//
// Filters:
//   - unread     ?unread=true       only unread + not dismissed
//   - kind       ?kind=listing.shared
// Order: created_at DESC.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  unread: z.coerce.boolean().optional(),
  kind: z.string().max(80).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const q = query as z.infer<typeof querySchema>
    const page = q.page
    const pageSize = q.page_size

    let sb: any = (supabase as any)
      .from('notifications')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (q.unread) {
      sb = sb.is('read_at', null).is('dismissed_at', null)
    }
    if (q.kind) sb = sb.eq('kind', q.kind)

    const from = (page - 1) * pageSize
    const to = from + pageSize - 1
    sb = sb.range(from, to)

    const { data, error, count } = await sb
    if (error) {
      logger.error({ err: error.message, op: 'notifications.list' }, 'notifications_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Cheap top-of-app badge count: unread + not dismissed. Guarded
    // because a failure here (RLS hiccup, transient supabase issue)
    // shouldn't kill the whole notifications response — the list
    // already loaded successfully above. Caller falls back to 0.
    let unreadCount: number | null = 0
    try {
      const { count, error: unreadErr } = await (supabase as any)
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .is('read_at', null)
        .is('dismissed_at', null)
      if (unreadErr) {
        logger.warn(
          { err: unreadErr.message, op: 'notifications.unread_count' },
          'notifications_unread_count_failed',
        )
        unreadCount = null
      } else {
        unreadCount = count ?? 0
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'notifications.unread_count' },
        'notifications_unread_count_threw',
      )
      unreadCount = null
    }

    return {
      data: data ?? [],
      total: count ?? 0,
      unread_count: unreadCount ?? 0,
      page,
      page_size: pageSize,
      total_pages: count ? Math.ceil(count / pageSize) : 0,
    }
  },
})
