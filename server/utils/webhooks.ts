// Outbound webhook dispatcher.
//
// Looks up enabled subscriptions matching `kind`, signs each payload
// with HMAC-SHA256 using the subscription's secret, POSTs with a hard
// timeout, logs the delivery, manages reliability state.
//
// Failure policy: per-delivery best-effort. A failing partner doesn't
// block the calling code (inquiry / listing / verification flow), and
// failure of one subscription doesn't affect another's delivery.
//
// Auto-disable: after 10 consecutive failures, the subscription's
// enabled flag flips to false. Admin re-enables manually after fixing.
//
// Replay protection: each request carries `webhook-timestamp` and
// `webhook-signature`. Partners verify the signature against the raw
// body + timestamp string + their secret. They MUST reject requests
// where the timestamp is > 5 minutes old.

import { createHmac, randomUUID } from 'node:crypto'
import { getServerSupabaseAdmin } from './supabase'
import { logger } from './logger'

const DELIVERY_TIMEOUT_MS = 5000
const FAILURE_DISABLE_THRESHOLD = 10
const RESPONSE_EXCERPT_BYTES = 1024

// Retry schedule (seconds from previous attempt) — exponential-ish.
// Total wall time ≈ 31h before giving up. Attempt 1 is the inline
// dispatch; entries below are the delays before attempts 2..7.
//   2: 1m,  3: 5m,  4: 15m,  5: 1h,  6: 6h,  7: 24h
// Past attempt 7 (i.e., 6 retries) we give up and increment the
// subscription's consecutive_failures.
export const RETRY_BACKOFF_SECONDS = [60, 300, 900, 3600, 21600, 86400]
export const MAX_ATTEMPTS = 1 + RETRY_BACKOFF_SECONDS.length // = 7

type Subscription = {
  id: string
  url: string
  signing_secret: string
  event_kinds: string[]
  enabled: boolean
  consecutive_failures: number
}

// 5xx, network errors, and timeouts are transient — partner might
// recover. 4xx means partner explicitly rejected — retrying won't help.
function isRetryable(httpStatus: number | null, errorMessage: string | null): boolean {
  if (errorMessage) return true // network or timeout
  if (httpStatus === null) return true
  return httpStatus >= 500
}

function backoffSecondsFor(nextAttemptNumber: number): number {
  // nextAttemptNumber is the number we're scheduling, so its delay
  // index is (n-2). Defensive cap to last bucket.
  const idx = Math.min(
    Math.max(0, nextAttemptNumber - 2),
    RETRY_BACKOFF_SECONDS.length - 1,
  )
  return RETRY_BACKOFF_SECONDS[idx]!
}

/**
 * Fire-and-forget dispatch. Looks up matching subscriptions, fans
 * out delivery in parallel, returns when all complete (or timeout).
 *
 * Caller pattern:
 *   dispatchWebhook('inquiry.received', { id, listing_id, ... })
 *     .catch((err) => logger.warn({ err }, 'webhook_dispatch_threw'))
 *
 * Always attach a .catch() — the function awaits a Supabase call
 * before its inner try/catch wraps anything, so a transport-level
 * reject (e.g., admin client init succeeded but the schema-cache
 * lookup throws synchronously) escapes as an unhandled promise
 * rejection. Nitro logs those as `[request error] [unhandled]`
 * even when the calling endpoint already responded 2xx.
 *
 * If you need the result of dispatch, await it instead.
 */
export async function dispatchWebhook(
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  let admin: ReturnType<typeof getServerSupabaseAdmin>
  try {
    admin = getServerSupabaseAdmin()
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'webhooks.dispatch.admin_init' },
      'webhook_dispatch_admin_unavailable',
    )
    return
  }

  // Lookup. Partial index on enabled = true makes this cheap even
  // with thousands of subscriptions.
  const { data: subs, error } = await (admin as any)
    .from('webhook_subscriptions')
    .select('id, url, signing_secret, event_kinds, enabled, consecutive_failures')
    .eq('enabled', true)

  if (error) {
    logger.warn(
      { err: error.message, kind, op: 'webhooks.dispatch.lookup' },
      'webhook_dispatch_lookup_failed',
    )
    return
  }

  const matches = ((subs ?? []) as Subscription[]).filter(
    (s) => s.event_kinds.length === 0 || s.event_kinds.includes(kind),
  )
  if (matches.length === 0) return

  await Promise.all(matches.map((sub) => deliverOne(admin, sub, kind, payload)))
}

/**
 * Targeted dispatch for one specific subscription — the building block
 * for the admin replay endpoint. Uses the same attempt → record →
 * (retry-enqueue OR state-tick) pipeline as the fan-out path, so a
 * replay is indistinguishable from a fresh first-time delivery as far
 * as the partner / audit log / retry queue / disable counter are
 * concerned.
 *
 * Returns the chain id so the caller can confirm to the operator
 * which chain holds the new audit trail. Fails open to a no-op when
 * the subscription is gone or disabled (the runner-equivalent
 * outcome).
 */
export async function dispatchToSubscription(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
  subscriptionId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ chainId: string; outcome: 'ok' | 'enqueued' | 'failed' | 'sub_unavailable' }> {
  const { data: sub, error } = await (admin as any)
    .from('webhook_subscriptions')
    .select('id, url, signing_secret, event_kinds, enabled, consecutive_failures')
    .eq('id', subscriptionId)
    .maybeSingle()

  if (error || !sub) return { chainId: '', outcome: 'sub_unavailable' }
  if (!sub.enabled) return { chainId: '', outcome: 'sub_unavailable' }

  const chainId = randomUUID()
  const result = await attemptDelivery(sub as Subscription, kind, payload)
  await recordDelivery(admin, sub as Subscription, kind, payload, result, chainId)

  if (result.ok) {
    await updateSubscriptionState(admin, sub as Subscription, true, result.httpStatus)
    return { chainId, outcome: 'ok' }
  }

  if (isRetryable(result.httpStatus, result.errorMessage)) {
    try {
      await (admin as any).from('webhook_retry_queue').insert({
        subscription_id: sub.id,
        event_kind: kind,
        payload,
        attempt_number: 1,
        next_attempt_at: new Date(Date.now() + backoffSecondsFor(2) * 1000).toISOString(),
        last_status: result.httpStatus,
        last_error: result.errorMessage,
        delivery_chain_id: chainId,
      })
      return { chainId, outcome: 'enqueued' }
    } catch {
      await updateSubscriptionState(admin, sub as Subscription, false, result.httpStatus)
      return { chainId, outcome: 'failed' }
    }
  }

  await updateSubscriptionState(admin, sub as Subscription, false, result.httpStatus)
  return { chainId, outcome: 'failed' }
}

async function deliverOne(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
  sub: Subscription,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Generate the chain id up front. Every audit row written for this
  // logical event — first attempt + any retries — carries this id, so
  // the admin UI can group them together. The retry queue stores it
  // too; attemptQueueDelivery threads it through.
  const chainId = randomUUID()

  const result = await attemptDelivery(sub, kind, payload)
  await recordDelivery(admin, sub, kind, payload, result, chainId)

  if (result.ok) {
    await updateSubscriptionState(admin, sub, /*success*/ true, result.httpStatus)
    return
  }

  // Transient failure on the inline first attempt → enqueue retry.
  // Don't tick consecutive_failures yet; that happens only when the
  // retry chain exhausts (handled by the worker calling
  // `attemptQueueDelivery`).
  if (isRetryable(result.httpStatus, result.errorMessage)) {
    try {
      await (admin as any).from('webhook_retry_queue').insert({
        subscription_id: sub.id,
        event_kind: kind,
        payload,
        attempt_number: 1,
        next_attempt_at: new Date(Date.now() + backoffSecondsFor(2) * 1000).toISOString(),
        last_status: result.httpStatus,
        last_error: result.errorMessage,
        delivery_chain_id: chainId,
      })
    } catch (err: any) {
      logger.warn(
        { err: err?.message, sub_id: sub.id, op: 'webhooks.retry_enqueue' },
        'webhook_retry_enqueue_failed',
      )
      // Enqueue failed; treat as terminal so the failure counter
      // still reflects the dropped event.
      await updateSubscriptionState(admin, sub, /*success*/ false, result.httpStatus)
    }
    return
  }

  // Non-retryable (4xx) — terminal first attempt. Tick counter.
  await updateSubscriptionState(admin, sub, /*success*/ false, result.httpStatus)
}

// Single attempt — fetch + HMAC + timeout. Returns the result tuple
// without writing audit / queue rows; callers compose the side effects.
type AttemptResult = {
  ok: boolean
  httpStatus: number | null
  errorMessage: string | null
  responseExcerpt: string | null
  durationMs: number
}

async function attemptDelivery(
  sub: Subscription,
  kind: string,
  payload: Record<string, unknown>,
): Promise<AttemptResult> {
  const startedAt = Date.now()
  const timestamp = String(Math.floor(startedAt / 1000))
  const body = JSON.stringify({ kind, data: payload, sent_at: new Date(startedAt).toISOString() })

  // HMAC-SHA256(timestamp + "." + body, secret) — Slack-style.
  // Partners verify by recomputing on their side.
  const signature = createHmac('sha256', sub.signing_secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')

  let httpStatus: number | null = null
  let responseExcerpt: string | null = null
  let errorMessage: string | null = null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS)

  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-event': kind,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1=${signature}`,
        'user-agent': 'HousingInteractive-Webhooks/1.0',
      },
      body,
      signal: ctrl.signal,
    })
    httpStatus = res.status
    try {
      const text = await res.text()
      responseExcerpt =
        text.length > RESPONSE_EXCERPT_BYTES
          ? text.slice(0, RESPONSE_EXCERPT_BYTES)
          : text
    } catch {
      responseExcerpt = null
    }
  } catch (err: any) {
    errorMessage = err?.name === 'AbortError'
      ? `timeout after ${DELIVERY_TIMEOUT_MS}ms`
      : (err?.message || String(err))
  } finally {
    clearTimeout(timer)
  }

  return {
    ok: httpStatus !== null && httpStatus >= 200 && httpStatus < 300,
    httpStatus,
    errorMessage,
    responseExcerpt,
    durationMs: Date.now() - startedAt,
  }
}

async function recordDelivery(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
  sub: Subscription,
  kind: string,
  payload: Record<string, unknown>,
  result: AttemptResult,
  chainId: string,
): Promise<void> {
  try {
    await (admin as any).from('webhook_deliveries').insert({
      subscription_id: sub.id,
      event_kind: kind,
      payload,
      http_status: result.httpStatus,
      response_excerpt: result.responseExcerpt,
      error_message: result.errorMessage,
      duration_ms: result.durationMs,
      delivery_chain_id: chainId,
    })
  } catch (err: any) {
    logger.warn(
      { err: err?.message, sub_id: sub.id, op: 'webhooks.delivery.log' },
      'webhook_delivery_log_failed',
    )
  }
}

async function updateSubscriptionState(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
  sub: Subscription,
  success: boolean,
  httpStatus: number | null,
): Promise<void> {
  try {
    if (success) {
      await (admin as any)
        .from('webhook_subscriptions')
        .update({
          consecutive_failures: 0,
          last_delivery_at: new Date().toISOString(),
          last_delivery_status: httpStatus,
        })
        .eq('id', sub.id)
    } else {
      const next = sub.consecutive_failures + 1
      const shouldDisable = next >= FAILURE_DISABLE_THRESHOLD
      await (admin as any)
        .from('webhook_subscriptions')
        .update({
          consecutive_failures: next,
          last_delivery_at: new Date().toISOString(),
          last_delivery_status: httpStatus,
          ...(shouldDisable ? { enabled: false } : {}),
        })
        .eq('id', sub.id)
      if (shouldDisable) {
        logger.warn(
          { sub_id: sub.id, url: sub.url, failures: next, op: 'webhooks.auto_disable' },
          'webhook_auto_disabled',
        )
      }
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, sub_id: sub.id, op: 'webhooks.state_update' },
      'webhook_state_update_failed',
    )
  }
}

// =====================================================================
// Retry queue worker — called from /api/admin/webhooks/run-retries
// =====================================================================

type QueueRow = {
  id: string
  subscription_id: string
  event_kind: string
  payload: Record<string, unknown>
  attempt_number: number
  delivery_chain_id: string
}

/**
 * Process one queue row: replay delivery, then either dequeue (success
 * or attempt-cap reached) or reschedule (transient + retries left).
 *
 * Called by the retry-runner endpoint, never from inline dispatch.
 */
export async function attemptQueueDelivery(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
  row: QueueRow,
): Promise<{ outcome: 'delivered' | 'rescheduled' | 'exhausted' | 'sub_missing' }> {
  // Refresh the subscription — it may have been disabled / deleted /
  // had its secret rotated since enqueue.
  const { data: sub, error } = await (admin as any)
    .from('webhook_subscriptions')
    .select('id, url, signing_secret, event_kinds, enabled, consecutive_failures')
    .eq('id', row.subscription_id)
    .maybeSingle()

  if (error || !sub) {
    // Subscription gone (FK CASCADE will likely have nuked the queue
    // row already; if not, dequeue defensively).
    await (admin as any).from('webhook_retry_queue').delete().eq('id', row.id)
    return { outcome: 'sub_missing' }
  }
  if (!sub.enabled) {
    // Disabled mid-retry — dequeue without further attempts.
    await (admin as any).from('webhook_retry_queue').delete().eq('id', row.id)
    return { outcome: 'sub_missing' }
  }

  const nextAttemptNumber = row.attempt_number + 1
  const result = await attemptDelivery(sub as Subscription, row.event_kind, row.payload)
  await recordDelivery(
    admin,
    sub as Subscription,
    row.event_kind,
    row.payload,
    result,
    row.delivery_chain_id,
  )

  if (result.ok) {
    await (admin as any).from('webhook_retry_queue').delete().eq('id', row.id)
    await updateSubscriptionState(admin, sub as Subscription, true, result.httpStatus)
    return { outcome: 'delivered' }
  }

  // Failure — decide retry vs. give up.
  const reachedCap = nextAttemptNumber >= MAX_ATTEMPTS
  const retryable = isRetryable(result.httpStatus, result.errorMessage)
  if (!retryable || reachedCap) {
    await (admin as any).from('webhook_retry_queue').delete().eq('id', row.id)
    await updateSubscriptionState(admin, sub as Subscription, false, result.httpStatus)
    return { outcome: 'exhausted' }
  }

  // Reschedule. nextAttemptNumber is the value AFTER this attempt;
  // backoff index is for the next-scheduled attempt (nextAttemptNumber + 1).
  const delaySec = backoffSecondsFor(nextAttemptNumber + 1)
  await (admin as any)
    .from('webhook_retry_queue')
    .update({
      attempt_number: nextAttemptNumber,
      next_attempt_at: new Date(Date.now() + delaySec * 1000).toISOString(),
      last_status: result.httpStatus,
      last_error: result.errorMessage,
    })
    .eq('id', row.id)
  return { outcome: 'rescheduled' }
}
