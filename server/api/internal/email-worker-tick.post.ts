// POST /api/internal/email-worker-tick
//
// Cron-runner endpoint. Claims a batch of pending outbound_emails
// rows, renders + sends each via the existing email.ts pipeline,
// and records the outcome.
//
// Auth: shared bearer secret (EMAIL_WORKER_SECRET env var). Operator
// configures their cron-runner (Vercel cron, AWS EventBridge,
// cron-job.org, etc.) to call this every 1-5 minutes with the secret.
//
// Body: { batch_size?: number = 50 }
//
// The actual sendEmail() in email.ts is currently a no-op stub —
// this endpoint will mark rows 'sent' but no emails leave the
// system until a real provider lands. That's intentional; the
// queue still records intent.

import { timingSafeEqual } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { renderEmail, sendEmail } from '~~/server/utils/email'
import { logger } from '~~/server/utils/logger'

function bearerAuthorized(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false
  if (!provided.startsWith('Bearer ')) return false
  const a = Buffer.from(provided.slice(7).trim(), 'utf8')
  const b = Buffer.from(expected.trim(), 'utf8')
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default defineEventHandler(async (event) => {
  const auth = getRequestHeader(event, 'authorization')
  const expected = process.env.EMAIL_WORKER_SECRET
  if (!expected) {
    throw createError({
      statusCode: 503,
      statusMessage: 'EMAIL_WORKER_SECRET not configured',
    })
  }
  if (!bearerAuthorized(auth, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const body = (await readBody(event).catch(() => ({}))) as { batch_size?: number }
  const batchSize = Math.min(Math.max(body.batch_size ?? 50, 1), 200)

  const admin = getServerSupabaseAdmin()

  // Claim a batch.
  const { data: rows, error: deqErr } = await (admin as any).rpc(
    'outbound_email_dequeue',
    { p_batch_size: batchSize },
  )
  if (deqErr) {
    logger.error(
      { err: deqErr.message, op: 'email-worker.dequeue' },
      'email_worker_dequeue_failed',
    )
    throw createError({ statusCode: 500, statusMessage: deqErr.message })
  }

  let sent = 0
  let failed = 0
  let skipped = 0

  for (const row of rows ?? []) {
    try {
      const tpl = renderEmail(row.template_kind, row.template_input ?? {})
      // Use the row.subject if explicitly supplied; otherwise fall
      // back to the template's computed subject. Helper sets it
      // explicitly so the queue UI shows the same subject.
      const subject = row.subject || tpl.subject

      // sendEmail is currently a no-op stub. When provider lands,
      // it will throw on transient failures (rate-limit, 5xx) so
      // we record those as failed retries.
      await sendEmail({ to: row.to_email, subject, html: tpl.html })

      await (admin as any).rpc('outbound_email_record_outcome', {
        p_id: row.id,
        p_status: 'sent',
        p_failure_reason: null,
      })
      sent += 1
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      logger.warn(
        { err: msg, row_id: row.id, kind: row.template_kind },
        'email_worker_send_failed',
      )
      await (admin as any).rpc('outbound_email_record_outcome', {
        p_id: row.id,
        p_status: 'failed',
        p_failure_reason: msg,
      })
      failed += 1
    }
  }

  // Heartbeat — best effort, never fail the run on a logging hiccup.
  await (admin as any)
    .rpc('record_worker_heartbeat', {
      p_worker_key: 'email_worker_tick',
      p_payload: {
        claimed: rows?.length ?? 0,
        sent,
        failed,
        skipped,
        batch_size: batchSize,
      },
    })
    .then(({ error }: { error: any }) => {
      if (error) {
        logger.warn(
          { err: error.message, op: 'email-worker.heartbeat' },
          'email_worker_heartbeat_failed',
        )
      }
    })
    .catch((err: any) => {
      logger.warn(
        { err: err?.message, op: 'email-worker.heartbeat' },
        'email_worker_heartbeat_failed',
      )
    })

  return {
    ok: true,
    claimed: rows?.length ?? 0,
    sent,
    failed,
    skipped,
  }
})
