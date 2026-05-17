// Manually trigger a syndication feed run.
//
// POST /api/admin/listing-syndication/targets/[id]/run-now
//
// Builds the feed in memory, writes a listing_syndication_runs audit
// row, and returns the serialized body. For pull-mode targets this
// is mostly an inspection / preview tool; for push-mode it would
// also POST to push_endpoint_url (push wiring deferred to phase B â€”
// this turn's run-now writes the audit row but does NOT push).

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
      throw createError({
        statusCode: 409,
        statusMessage: 'Target is archived; un-archive before running',
      })
    }

    // Open the run audit row up-front so failures land somewhere visible.
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
    try {
      feed = await selectListingsForTarget(admin as any, target as SyndicationTarget)
      // Phase B: dispatcher routes to JSON / XML based on feed_format.
      body = serializeFeed(target as SyndicationTarget, feed.listings)
    } catch (err: any) {
      logger.error(
        { err: err?.message, op: 'admin.syndication.run_now.serialize', target_id: targetId },
        'syndication_run_serialize_failed',
      )
      // Stamp the run as failed, then surface the error.
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
        .update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'failed',
        })
        .eq('id', targetId)
      throw createError({
        statusCode: 500,
        statusMessage: `Feed run failed: ${err?.message ?? 'unknown'}`,
      })
    }

    // Stamp the run audit + denormalised target bookkeeping.
    const completedAt = new Date().toISOString()
    await (admin as any)
      .from('listing_syndication_runs')
      .update({
        status: 'completed',
        completed_at: completedAt,
        listings_included: feed.listings.length,
        listings_excluded: feed.forced_out,
        bytes_emitted: Buffer.byteLength(body, 'utf8'),
        metadata: {
          forced_in: feed.forced_in,
          forced_out: feed.forced_out,
          push_attempted: false,
        },
      })
      .eq('id', run.id)

    await (admin as any)
      .from('listing_syndication_targets')
      .update({
        last_run_at: completedAt,
        last_run_listings: feed.listings.length,
        last_run_status: 'completed',
      })
      .eq('id', targetId)

    await logActivity({
      event,
      action: 'syndication.run_now',
      entity: 'syndication_target' as any,
      entityId: targetId,
      metadata: {
        run_id: run.id,
        listings_included: feed.listings.length,
        forced_in: feed.forced_in,
        forced_out: feed.forced_out,
        triggered: 'manual',
      },
    })

    return {
      run_id: run.id,
      target: { id: target.id, slug: target.slug, feed_format: target.feed_format },
      listings_included: feed.listings.length,
      forced_in: feed.forced_in,
      forced_out: feed.forced_out,
      bytes_emitted: Buffer.byteLength(body, 'utf8'),
      content_type: contentTypeFor(target.feed_format as SyndicationTarget['feed_format']),
      // Echo the body so the operator can preview it. Truncate at 256 KB
      // to keep the JSON response under reasonable bounds.
      body_preview: body.length > 262_144 ? body.slice(0, 262_144) + '\nâ€¦(truncated)' : body,
    }
  },
})
