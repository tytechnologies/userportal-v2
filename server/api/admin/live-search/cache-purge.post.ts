// Admin — purge live_search_cache.
//
// POST /api/admin/live-search/cache-purge
// Body: { provider_slug? } — when omitted, purges everything expired.
//        When set, purges all rows for that provider (operator wants
//        to force a re-fetch after tuning).
//
// Returns { deleted, swept_events }.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const bodySchema = z.object({
  provider_slug: z.string().min(1).max(80).optional(),
  // When true, also runs the expire RPC to sweep old search_events.
  sweep_events: z.boolean().default(false),
  event_retention_days: z.coerce.number().int().min(1).max(365).default(30),
})

export default defineEventHandler(async (event) => {
  const parsed = bodySchema.safeParse((await readBody(event)) ?? {})
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Invalid body',
      data: { issues: parsed.error.issues },
    })
  }
  const body = parsed.data

  const supabase = await serverSupabaseClient(event)

  let deleted = 0
  if (body.provider_slug) {
    const { error, count } = await supabase
      .from('live_search_cache')
      .delete({ count: 'exact' })
      .eq('provider_slug', body.provider_slug)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    deleted = count ?? 0
  } else {
    // Lean on the RPC for the expired-row sweep.
    const { data, error } = await (supabase as any).rpc('expire_live_search_cache', {
      p_event_retention_days: body.event_retention_days,
    })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    const row = Array.isArray(data) ? data[0] : data
    return {
      ok: true,
      deleted: Number(row?.cache_rows_deleted ?? 0),
      swept_events: Number(row?.event_rows_deleted ?? 0),
    }
  }

  let sweptEvents = 0
  if (body.sweep_events) {
    const { data: sweep, error: sweepErr } = await (supabase as any).rpc(
      'expire_live_search_cache',
      { p_event_retention_days: body.event_retention_days },
    )
    if (!sweepErr) {
      const row = Array.isArray(sweep) ? sweep[0] : sweep
      sweptEvents = Number(row?.event_rows_deleted ?? 0)
    }
  }

  return { ok: true, deleted, swept_events: sweptEvents }
})
