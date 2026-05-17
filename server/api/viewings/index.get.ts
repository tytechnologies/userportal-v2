// List viewings across all deals â€” the broker's daily-schedule
// surface.
//
// GET /api/viewings?from=&to=&mine=true&status=scheduled
// Auth: required.
//
// Defaults: from=now-1d, to=now+14d, status=scheduled. The default
// window is "tomorrow + the next two weeks plus a yesterday tail"
// so the broker's morning view shows today, late-arriving past-day
// follow-ups, and the upcoming pipeline in one fetch.
//
// `mine=true` scopes to viewings where the caller is the attending
// agent OR is a participant on the deal (RLS already restricts the
// rows the caller can see; this filter narrows further to "schedule
// I personally need to keep").
//
// Hydration: each row carries the parent deal's listing_id +
// listing.title + buyer_contact summary so the broker doesn't need
// to drill into the deal to know "what listing, which buyer."

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  from:   z.string().datetime({ offset: true }).optional(),
  to:     z.string().datetime({ offset: true }).optional(),
  mine:   z.coerce.boolean().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  limit:  z.coerce.number().int().min(1).max(500).default(200),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const now = Date.now()
    const fromIso = q.from ?? new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString()
    const toIso   = q.to   ?? new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString()

    // Pull deal pointers + light hydration. RLS on deal_viewings
    // depends on deal participation, so the caller only sees rows
    // for deals they can read â€” same pattern as deals.list.
    // The deals table has multiple FKs to listings (deals_listing_id_fkey
    // is the primary; some deployments also have a secondary listing
    // pointer for transferred-deal lineage). Without an explicit
    // constraint name PostgREST refuses to embed and 500s with
    // "more than one relationship found." Pin the constraint names
    // for every embedded relationship to be safe.
    let sb: any = (supabase as any)
      .from('deal_viewings')
      .select(`
        id,
        deal_id,
        scheduled_at,
        duration_minutes,
        status,
        notes,
        buyer_interest,
        attending_user_id,
        attending:profiles!deal_viewings_attending_user_id_fkey (id, full_name, avatar_url),
        deal:deals!deal_viewings_deal_id_fkey (
          id,
          title,
          stage_key,
          listing_id,
          listing:listings!deals_listing_id_fkey (
            id,
            title,
            sale_price,
            rent_price
          ),
          buyer_contact:contacts!deals_buyer_contact_id_fkey (
            id,
            full_name,
            email,
            mobile_phone
          )
        )
      `)
      .gte('scheduled_at', fromIso)
      .lte('scheduled_at', toIso)
      .order('scheduled_at', { ascending: true })
      .limit(q.limit)

    if (q.status) sb = sb.eq('status', q.status)
    if (q.mine)   sb = sb.eq('attending_user_id', user.id)

    const { data, error } = await sb
    if (error) {
      logger.error({ err: error.message, op: 'viewings.list' }, 'viewings_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      data: data ?? [],
      from: fromIso,
      to:   toIso,
    }
  },
})
