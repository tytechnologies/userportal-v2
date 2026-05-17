import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

// Listing-scoped activity feed for the sidebar timeline. RLS on activities
// is what actually limits what the caller sees — this route just narrows
// the query to a single listing.
export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('activities')
      .select(
        'id, user_id, action, entity, entity_id, metadata, created_at, actor:profiles!user_id (id, full_name, email, avatar_url)',
      )
      .eq('entity', 'listing')
      .eq('metadata->>listing_id', String(id))
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) {
      logger.error(
        { err: error.message, op: 'listings.activities', id },
        'listing_activities_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { data: data ?? [] }
  },
})
