// List transaction rooms this draft is linked to. Read-through to
// transaction_room_documents → transaction_rooms via the FK; RLS on
// the rooms table scopes to rooms the caller can read.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('transaction_room_documents')
      .select(`
        id, room_id, added_at,
        room:transaction_rooms (id, name, status, listing_id, deal_id)
      `)
      .eq('draft_id', id)
      .order('added_at', { ascending: false })
    if (error) {
      logger.error({ err: error.message, op: 'doc.rooms.list' }, 'doc_rooms_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    // Filter out junctions whose parent room the caller can't read
    // (RLS on transaction_rooms returned null for those).
    const visible = (data ?? []).filter((r: any) => r.room)
    return { data: visible }
  },
})
