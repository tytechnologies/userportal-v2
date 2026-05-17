// Manually push a syndication target's feed to its partner endpoint.
//
// POST /api/admin/listing-syndication/targets/[id]/push-now
//
// Builds the feed in memory (same dispatcher as pull mode), POSTs to
// `push_endpoint_url` with the configured auth shape, and writes a
// `listing_syndication_runs` row stamping the response status + body
// excerpt. Idempotent â€” operator can re-run safely (each call writes
// a fresh run row).
//
// 422 if the target is configured for pull mode (no push endpoint
// expected). 422 if the secret env var is missing.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'
import {
  selectListingsForTarget,
  serializeFeed,
  contentTypeFor,
  type SyndicationTarget,
} from '~~/server/utils/syndicationFeed'
import { pushFeedToTarget, type PushTarget } from '~~/server/utils/syndicationPush'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    await requireRole(event, 'manager')

    const targetId = getRouterParam(event, 'id')
    if (!targetId || !/^[0-9a-f-]{36}$/i.test(targetId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid target id' })
    }

    const admin = getServerSupabaseAdmin()

    const { data: target, error: targetErr } = await (admin as any)
      .from('listing_syndication_targets')
      .select('*')
      .eq('id', targetId)
      .maybeSingle()
    if (targetErr) {
      throw createError({ statusCode: 500, statusMessage: targetErr.message })
    }
    if (!target) {
      throw createError({ statusCode: 404, statusMessage: 'Target not found' })
    }
    if (target.status === 'archived') {
      throw createError({ statusCode: 409, statusMessage: 'Target is archived' })
    }
    if (target.delivery_mode !== 'push') {
      throw createError({
        statusCode: 422,
        statusMessage: 'Target is in pull mode; partner polls the public URL instead',
      })
    }
    if (!target.push_endpoint_url) {
      throw createError({
        statusCode: 422,
        statusMessage: 'push_endpoint_url is not set on the target',
      })
    }

    // Open the audit row up-front so any failure lands somewhere visible.
    const { data: run, error: runErr } = await (admin as any)
      .from('listing_syndication_runs')
      .insert({
        target_id: targetId,
        triggered_by: user?.id ?? null,
        run_kind: 'manual',
      })
      .select('id')
      .single()
    if (runErr) {
      throw createError({ statusCode: 500, statusMessage: runErr.message })
    }

    let feed: { listings: any[]; forced_in: number; forced_out: number }
    let body: string
    let contentType: string
    try {
      feed = await selectListingsForTarget(admin as any, target as SyndicationTarget)
      contentType = contentTypeFor(target.feed_format as SyndicationTarget['feed_format'])
      body = serializeFeed(target as SyndicationTarget, feed.listings)
    } catch (err: any) {
      logger.error(
        { err: err?.message, op: 'admin.syndication.push_now.serialize', target_id: targetId },
        'syndication_push_serialize_failed',
      )
      await (admin as any)
        .from('listing_syndication_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          errors: [{ message: err?.message ?? 'unknown', stage: 'serialize' }],
        })
        .eq('id', run.id)
      await (admin as any)
        .from('listing_syndication_targets')
        .update({ last_run_at: new Date().toISOString(), last_run_status: 'failed' })
        .eq('id', targetId)
      throw createError({
        statusCode: 500,
        statusMessage: `Feed serialize failed: ${err?.message ?? 'unknown'}`,
      })
    }

    // Actual HTTP push.
    const outcome = await pushFeedToTarget(target as PushTarget, contentType, body)

    const completedAt = new Date().toISOString()
    await (admin as any)
      .from('listing_syndication_runs')
      .update({
        status: outcome.ok ? 'completed' : 'failed',
        completed_at: completedAt,
        listings_included: feed.listings.length,
        listings_excluded: feed.forced_out,
        bytes_emitted: Buffer.byteLength(body, 'utf8'),
        push_response_status: outcome.status_code,
        push_response_body_excerpt: outcome.body_excerpt,
        errors: outcome.error
          ? [{ message: outcome.error, stage: 'push' }]
          : [],
        metadata: {
          forced_in: feed.forced_in,
          forced_out: feed.forced_out,
          push_attempted: true,
          push_duration_ms: outcome.duration_ms,
        },
      })
      .eq('id', run.id)

    await (admin as any)
      .from('listing_syndication_targets')
      .update({
        last_run_at: completedAt,
        last_run_listings: feed.listings.length,
        last_run_status: outcome.ok ? 'completed' : 'failed',
      })
      .eq('id', targetId)

    await logActivity({
      event,
      action: 'syndication.push_now',
      entity: 'syndication_target' as any,
      entityId: targetId,
      metadata: {
        run_id: run.id,
        listings_included: feed.listings.length,
        push_response_status: outcome.status_code,
        push_ok: outcome.ok,
        triggered: 'manual',
      },
    })

    return {
      run_id: run.id,
      target: { id: target.id, slug: target.slug, feed_format: target.feed_format },
      listings_included: feed.listings.length,
      bytes_emitted: Buffer.byteLength(body, 'utf8'),
      push: outcome,
    }
  },
})
