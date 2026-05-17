import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Listing-scoped feed. When set, returns only activities for that listing
  // (entity = 'listing' AND metadata.listing_id = listingId).
  listing_id: z.coerce.number().int().positive().optional(),
  entity: z.string().optional(),
})

// Latest activities visible to the caller. RLS on activities decides
// what's actually returned: agents see their own actions, managers see
// their team, admins see everything.
export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    const limit = (query as any).limit ?? 50
    const listingId = (query as any).listing_id as number | undefined
    const entity = (query as any).entity as string | undefined

    let q: any = client
      .from('activities')
      .select(
        // Hydrate the actor in one round trip; the activities row only has
        // user_id (uuid) and the UI wants a name.
        'id, user_id, action, entity, entity_id, metadata, created_at, actor:profiles!user_id (id, full_name, email, avatar_url)',
      )
      .order('created_at', { ascending: false })
      .limit(limit)

    if (entity) q = q.eq('entity', entity)
    if (listingId !== undefined) {
      q = q.eq('entity', 'listing').eq('metadata->>listing_id', String(listingId))
    }

    const { data, error } = await q
    if (error) {
      logger.error({ err: error.message, op: 'activities.list' }, 'activities_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { data: data ?? [] }
  },
})
