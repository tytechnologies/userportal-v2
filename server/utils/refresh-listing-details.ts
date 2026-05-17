import type { H3Event } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

// Side-effect helper for refreshing the listing_details materialized view.
//
// Two modes:
//
//   refreshListingDetails(eventOrClient, op)
//       — DEFAULT debounced path. Calls request_listing_details_refresh
//         (mig 20260513000004) which flips a single coalescer row in
//         sub-ms. The actual MV refresh runs out-of-band every 30s
//         via the pg_cron worker `process_listing_details_refresh`.
//         Multiple requests within a window collapse to one refresh.
//
//   refreshListingDetails(eventOrClient, op, { force: true })
//       — IMMEDIATE refresh. Calls refresh_listing_details directly;
//         the caller awaits the full refresh. Use only when fresh
//         data must be visible BEFORE the response returns (admin
//         "Refresh now" buttons; smoke tests). Most write paths
//         should leave force=false.
//
// Never throws — refresh failures (or coalescer migration not yet
// applied) MUST NOT take down the user-facing write that succeeded.
// `op` identifies the call site in logs for post-hoc analysis of
// which write paths are landing on a stale view.
export async function refreshListingDetails(
  arg: H3Event | SupabaseClient,
  op: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const force = options.force === true
  try {
    // Accept either an H3 event (lazy-resolves the request-scoped client) or
    // an already-resolved client, so call sites that already have a `client`
    // don't pay for a second resolution.
    const client: SupabaseClient =
      'on' in (arg as any) || 'node' in (arg as any)
        ? await serverSupabaseClient(arg as H3Event)
        : (arg as SupabaseClient)

    if (force) {
      const { error } = await client.rpc('refresh_listing_details')
      if (error) {
        logger.warn(
          { err: error.message, op, mode: 'force' },
          'refresh_listing_details_failed',
        )
        return
      }
      logger.debug({ op, mode: 'force' }, 'refresh_listing_details_ok')
      return
    }

    // Debounced path — sub-ms; the cron worker performs the actual
    // refresh on the next 30s tick.
    const { error: reqErr } = await client.rpc('request_listing_details_refresh')
    if (reqErr) {
      // Drift-safe: if mig 513000004 isn't applied in this env, fall
      // back to the direct refresh so behavior matches pre-debouncer.
      // refresh_listing_details() is itself short-circuit-cheap when
      // nothing has changed, so the fallback isn't a hot-path tax.
      logger.warn(
        { err: reqErr.message, op, mode: 'debounced' },
        'refresh_request_failed_falling_back',
      )
      const { error: fbErr } = await client.rpc('refresh_listing_details')
      if (fbErr) {
        logger.warn(
          { err: fbErr.message, op, mode: 'fallback' },
          'refresh_listing_details_failed',
        )
      }
      return
    }
    logger.debug({ op, mode: 'debounced' }, 'refresh_listing_details_queued')
  } catch (err) {
    // RPC missing (migration not yet applied), network blip, etc. — swallow.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), op },
      'refresh_listing_details_threw',
    )
  }
}

/**
 * Force-immediate refresh — convenience wrapper for code that
 * explicitly wants synchronous behavior (admin tools, tests).
 * Equivalent to `refreshListingDetails(arg, op, { force: true })`.
 */
export async function refreshListingDetailsImmediate(
  arg: H3Event | SupabaseClient,
  op: string,
): Promise<void> {
  return refreshListingDetails(arg, op, { force: true })
}
