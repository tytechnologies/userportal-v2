// Saved-search digest run.
//
// Iterates every confirmed subscription whose digest is due
// (`saved_searches_due_for_digest()` RPC), looks up matching listings
// from `public_listing_details`, builds a digest email, and fires it
// via Mailgun. Stamps `last_digest_sent_at` per row so a re-invocation
// within the cadence window is a no-op.
//
// Auth (dual path):
//   1. Admin user JWT — manual triggers from the portal, ad-hoc runs.
//   2. `x-internal-secret` header matching INTERNAL_CRON_SECRET env —
//      pg_cron / EventBridge / any external scheduler. Constant-time
//      compared. Falls back to admin path if env unset OR header
//      missing OR mismatch.
//
// Wire format:
//   POST /api/admin/saved-searches/run-digest
//   Auth: admin JWT  OR  x-internal-secret: <INTERNAL_CRON_SECRET>
//   Body: { dryRun?: boolean }
//   200 → {
//     processed: N,        // rows considered due
//     sent:      M,        // emails that would have been sent (provider currently a no-op stub)
//     skipped:   K,        // due rows that produced zero matches
//     errors:    [...]     // per-row failure summaries
//     triggered_by: 'admin' | 'cron'
//   }
//
// Failure policy: per-row errors are caught + recorded in the
// response, never throw out of the loop. The HTTP response is always
// 200 unless the entire setup fails (DB unreachable, etc.). This is
// the same fire-and-forget posture as notify() / sendEmail().
//
// Idempotency: due rows stamped with `last_digest_sent_at = now()`
// at the START of their iteration. A re-run within the cadence
// window finds no due rows and no-ops. A row with zero matches is
// also stamped — we did consider it, even if there was nothing to
// send. (The alternative of NOT stamping would re-process every
// digest cycle, eventually yielding stale matches.)

import { timingSafeEqual } from 'node:crypto'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'
import { sendEmail } from '~~/server/utils/email'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import {
  loadMatchingListings,
  buildDigestEmail,
  digestBaseUrl,
} from '~~/server/utils/savedSearchDigest'

type DueRow = {
  id: string
  email: string
  name: string | null
  filters: Record<string, unknown>
  digest_frequency: 'daily' | 'weekly'
  last_digest_sent_at: string | null
  unsubscribe_token: string
}

/**
 * Constant-time check against `INTERNAL_CRON_SECRET`. Returns false if
 * the env is unset (fail-closed) or the header is missing/wrong length.
 * Equal-length, equal-character strings → true. Anything else → false.
 */
function isCronAuthorized(event: Parameters<typeof getRequestHeader>[0]): boolean {
  const secret = (process.env.INTERNAL_CRON_SECRET ?? '').trim()
  if (secret.length === 0) return false

  const provided = (getRequestHeader(event, 'x-internal-secret') ?? '').trim()
  if (provided.length === 0) return false

  // timingSafeEqual requires equal-length buffers. Length-mismatch is a
  // pre-condition fail (also non-secret) → return false without leak.
  const a = Buffer.from(secret, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default defineApiHandler({
  auth: 'optional',
  handler: async ({ event }) => {
    // Dual auth: cron-secret bypass takes precedence so a scheduler
    // without a user JWT can trigger; otherwise fall back to the
    // admin-role check (preserves the manual-trigger UX).
    const isCron = isCronAuthorized(event)
    if (!isCron) {
      await requireRole(event, 'admin')
    }
    const triggeredBy = isCron ? 'cron' : 'admin'

    const body = (await readBody(event).catch(() => ({}))) as {
      dryRun?: boolean
    }
    const dryRun = body?.dryRun === true

    const client = await serverSupabaseClient(event)
    const admin = getServerSupabaseAdmin()

    // 1. Find every due subscription. RPC respects RLS but the
    //    function is SECURITY DEFINER so admin-role auth is enough.
    const { data: due, error: dueErr } = await (client as any)
      .rpc('saved_searches_due_for_digest')

    if (dueErr) {
      logger.error(
        { err: dueErr.message, op: 'saved_searches.run_digest.fetch_due' },
        'saved_search_digest_fetch_due_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not load due subscriptions',
      })
    }

    const dueRows: DueRow[] = (due ?? []) as DueRow[]
    const errors: Array<{ id: string; email: string; reason: string }> = []
    let sent = 0
    let skipped = 0

    const baseUrl = digestBaseUrl()

    for (const row of dueRows) {
      try {
        const since = row.last_digest_sent_at
          // First-ever digest for this row: look back 7 days. Bounds
          // the digest size and matches the typical "what's new"
          // expectation for a freshly-confirmed subscription.
          ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

        const matches = await loadMatchingListings(admin, row.filters, since)

        // Stamp BEFORE deciding to send. See header comment for why.
        if (!dryRun) {
          await (admin as any)
            .from('saved_search_subscriptions')
            .update({ last_digest_sent_at: new Date().toISOString() })
            .eq('id', row.id)
        }

        if (matches.length === 0) {
          skipped++
          continue
        }

        const tpl = buildDigestEmail({
          recipientName: row.name,
          matches,
          baseUrl,
          unsubscribeToken: row.unsubscribe_token,
        })

        if (dryRun) {
          // Don't actually call Mailgun; just count what would have
          // gone out. Useful for "is this worker doing the right
          // thing?" sanity checks.
          sent++
          continue
        }

        // sendEmail is fire-and-forget — never throws.
        await sendEmail({ to: row.email, subject: tpl.subject, html: tpl.html })
        sent++
      } catch (err: any) {
        errors.push({
          id: row.id,
          email: row.email,
          reason: err?.message || String(err),
        })
        logger.warn(
          {
            err: err?.message,
            sub_id: row.id,
            op: 'saved_searches.run_digest.row',
          },
          'saved_search_digest_row_failed',
        )
      }
    }

    await logActivity({
      event,
      client,
      action: 'saved_search.digest_run',
      // Audit `entity` accepts any text; this isn't in the named union
      // (the AuditEntity type has a `string & {}` fallback). Treating
      // the run itself as the entity for traceability.
      entity: 'saved_search' as any,
      metadata: {
        processed: dueRows.length,
        sent,
        skipped,
        errors: errors.length,
        dry_run: dryRun,
        triggered_by: triggeredBy,
      },
    })

    return {
      processed: dueRows.length,
      sent,
      skipped,
      errors,
      dry_run: dryRun,
      triggered_by: triggeredBy,
    }
  },
})
