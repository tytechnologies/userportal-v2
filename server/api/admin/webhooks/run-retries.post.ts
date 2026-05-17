// Drain the webhook_retry_queue.
//
// POST /api/admin/webhooks/run-retries
// Auth (dual path):
//   1. Admin JWT — manual ad-hoc runs from the portal.
//   2. x-internal-secret header matching INTERNAL_CRON_SECRET — pg_cron
//      hits this once a minute. Constant-time compared.
//
// Behaviour:
//   - Pulls up to BATCH_LIMIT due rows (next_attempt_at <= now()).
//   - Replays each via attemptQueueDelivery — common path with the
//     inline dispatcher, so retries don't drift from initial sends.
//   - Returns counts: { processed, delivered, rescheduled, exhausted,
//     errors }. Always 200; per-row failures bubble into the errors
//     array so a flapping partner doesn't crash the worker.
//
// Concurrency: this endpoint is single-shot per cron tick. If a tick
// takes longer than 60s the next tick fires while the first is still
// running — both will see the same due rows. We don't lock here; the
// at-most-once guarantee comes from the dequeue happening AFTER the
// fetch + attempt, so a race produces at most one duplicate POST per
// row. Partners must idempotency-key against (event_kind, payload) if
// duplicates are unacceptable.
//
// Same INTERNAL_CRON_SECRET pattern saved-search digest run uses.

import { timingSafeEqual } from 'node:crypto'
import { requireRole } from '~~/server/utils/rbac'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { attemptQueueDelivery } from '~~/server/utils/webhooks'

const BATCH_LIMIT = 50

function isCronAuthorized(event: Parameters<typeof getRequestHeader>[0]): boolean {
  const secret = (process.env.INTERNAL_CRON_SECRET ?? '').trim()
  if (secret.length === 0) return false
  const provided = (getRequestHeader(event, 'x-internal-secret') ?? '').trim()
  if (provided.length === 0) return false
  const a = Buffer.from(secret, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default defineApiHandler({
  auth: 'optional',
  handler: async ({ event }) => {
    const isCron = isCronAuthorized(event)
    if (!isCron) await requireRole(event, 'admin')
    const triggeredBy = isCron ? 'cron' : 'admin'

    let admin: ReturnType<typeof getServerSupabaseAdmin>
    try {
      admin = getServerSupabaseAdmin()
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'webhooks.run_retries.admin_init' },
        'webhook_retries_admin_unavailable',
      )
      return { processed: 0, delivered: 0, rescheduled: 0, exhausted: 0, errors: [] }
    }

    const nowIso = new Date().toISOString()
    const { data: rows, error: fetchErr } = await (admin as any)
      .from('webhook_retry_queue')
      .select(
        'id, subscription_id, event_kind, payload, attempt_number, delivery_chain_id',
      )
      .lte('next_attempt_at', nowIso)
      .order('next_attempt_at', { ascending: true })
      .limit(BATCH_LIMIT)

    if (fetchErr) {
      logger.warn(
        { err: fetchErr.message, op: 'webhooks.run_retries.fetch' },
        'webhook_retries_fetch_failed',
      )
      throw createError({ statusCode: 500, statusMessage: fetchErr.message })
    }

    const queueRows = (rows ?? []) as Array<{
      id: string
      subscription_id: string
      event_kind: string
      payload: Record<string, unknown>
      attempt_number: number
      delivery_chain_id: string
    }>

    let delivered = 0
    let rescheduled = 0
    let exhausted = 0
    const errors: Array<{ id: string; reason: string }> = []

    for (const row of queueRows) {
      try {
        const { outcome } = await attemptQueueDelivery(admin, row)
        if (outcome === 'delivered') delivered++
        else if (outcome === 'rescheduled') rescheduled++
        else if (outcome === 'exhausted') exhausted++
        // 'sub_missing' silently dequeues — already counted by neither bucket.
      } catch (err: any) {
        errors.push({ id: row.id, reason: err?.message || String(err) })
        logger.warn(
          {
            err: err?.message,
            queue_id: row.id,
            sub_id: row.subscription_id,
            op: 'webhooks.run_retries.row',
          },
          'webhook_retry_row_failed',
        )
      }
    }

    return {
      processed: queueRows.length,
      delivered,
      rescheduled,
      exhausted,
      errors,
      triggered_by: triggeredBy,
    }
  },
})
