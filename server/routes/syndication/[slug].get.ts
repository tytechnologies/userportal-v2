// Public listing-syndication feed.
//
// GET /syndication/<slug>
//
// Anonymous, rate-limited (60/hour per IP). Partners poll this URL on
// their own cadence. Writes a `listing_syndication_runs` row with
// run_kind='pull' so operators can see who's fetching and when.
//
// Phase A: JSON only. Other formats (XML/CSV/RSS) throw a 501 with a
// clear message — they land in phase B. Multiple-format URLs (.xml,
// .csv) get separate route files.
//
// Caching: this route is CDN-friendly. We set a short s-maxage so
// Cloudflare can absorb the bulk of partner polling traffic without
// hitting our DB.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { enforceRateLimit, clientIp } from '~~/server/utils/rate-limit'
import { logger } from '~~/server/utils/logger'
import {
  selectListingsForTarget,
  serializeFeed,
  contentTypeFor,
  type SyndicationTarget,
} from '~~/server/utils/syndicationFeed'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid slug' })
  }

  // Service-role admin client serves both the rate-limit RPC and the
  // feed query. RLS on listings is intentionally bypassed for the
  // public syndication path — operators gate what's syndicated via
  // the target's `include_filters` (default: status='active') and
  // per-listing overrides. The admin client is sanctioned for this
  // call site under the service-role allowlist documented in
  // CONTRIBUTING.md.
  const admin = getServerSupabaseAdmin()

  // 60 req/hour per IP. Generous enough for partners polling every
  // 5 minutes; tight enough to absorb a botnet without flooding the DB.
  await enforceRateLimit({
    event,
    client: admin,
    key: `syndication:${slug}:${clientIp(event)}`,
    max: 60,
    windowSeconds: 3600,
  })
  const { data: target, error: targetErr } = await (admin as any)
    .from('listing_syndication_targets')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle()
  if (targetErr) {
    logger.error(
      { err: targetErr.message, op: 'syndication.public', slug },
      'syndication_public_lookup_failed',
    )
    throw createError({ statusCode: 500, statusMessage: 'Lookup failed' })
  }
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'Feed not found' })
  }

  // Open the run row up-front so failed runs are observable.
  const { data: run } = await (admin as any)
    .from('listing_syndication_runs')
    .insert({
      target_id: target.id,
      run_kind: 'pull',
      pull_origin: {
        ip: clientIp(event),
        user_agent: getRequestHeader(event, 'user-agent') ?? null,
        referer: getRequestHeader(event, 'referer') ?? null,
      },
    })
    .select('id')
    .single()

  let feed: { listings: any[]; forced_in: number; forced_out: number }
  let body: string
  let contentType: string
  try {
    feed = await selectListingsForTarget(admin as any, target as SyndicationTarget)
    contentType = contentTypeFor(target.feed_format as SyndicationTarget['feed_format'])
    body = serializeFeed(target as SyndicationTarget, feed.listings)
  } catch (err: any) {
    logger.error(
      { err: err?.message, op: 'syndication.public.serialize', slug },
      'syndication_public_serialize_failed',
    )
    if (run?.id) {
      await (admin as any)
        .from('listing_syndication_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          errors: [{ message: err?.message ?? 'unknown', stage: 'serialize' }],
        })
        .eq('id', run.id)
    }
    // Distinguish "not implemented yet" from a real internal error.
    if (/not yet implemented/i.test(err?.message ?? '')) {
      throw createError({ statusCode: 501, statusMessage: err.message })
    }
    throw createError({ statusCode: 500, statusMessage: 'Feed generation failed' })
  }

  // Stamp run + denormalised target fields.
  const completedAt = new Date().toISOString()
  if (run?.id) {
    void (admin as any)
      .from('listing_syndication_runs')
      .update({
        status: 'completed',
        completed_at: completedAt,
        listings_included: feed.listings.length,
        listings_excluded: feed.forced_out,
        bytes_emitted: Buffer.byteLength(body, 'utf8'),
        metadata: { forced_in: feed.forced_in, forced_out: feed.forced_out },
      })
      .eq('id', run.id)
      .then(({ error }: { error: any }) => {
        if (error) {
          logger.warn(
            { err: error.message, op: 'syndication.public.run_stamp' },
            'syndication_run_stamp_failed',
          )
        }
      })
  }
  void (admin as any)
    .from('listing_syndication_targets')
    .update({
      last_run_at: completedAt,
      last_run_listings: feed.listings.length,
      last_run_status: 'completed',
    })
    .eq('id', target.id)
    .then(({ error }: { error: any }) => {
      if (error) {
        logger.warn(
          { err: error.message, op: 'syndication.public.target_stamp' },
          'syndication_target_stamp_failed',
        )
      }
    })

  // Headers. Short edge cache to absorb partner polling traffic.
  setHeader(event, 'content-type', contentType)
  setHeader(event, 'cache-control', 'public, s-maxage=300, stale-while-revalidate=60')
  setHeader(event, 'x-feed-listings', String(feed.listings.length))
  setHeader(event, 'x-feed-generated-at', completedAt)

  return body
})
