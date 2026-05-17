// POST /api/internal/eis-submitter-tick
//
// Cron-runner endpoint. Polls eis_submissions WHERE status='queued',
// POSTs each payload to BIR EIS, and records the response. Operator
// points cron-runner here every 5-15 minutes.
//
// Auth: Bearer EIS_WORKER_SECRET (mirrors the email + AI workers).
//
// Body: { batch_size?: number = 20 }
//
// Provider behaviour:
//   * If EIS_PROVIDER_URL + EIS_PROVIDER_TOKEN are not set, the
//     worker runs in "noop" mode — it claims a queued row, marks
//     it submitted with submitted_at=now, but writes
//     metadata.noop_provider=true so the operator can tell it
//     never actually went over the wire. This lets the rest of the
//     pipeline (UI, audit log) be exercised without RDO accreditation.
//   * In live mode it POSTs the payload and reads the response into
//     status (accepted | rejected) + response_notes.
//
// IMPORTANT: row freeze trigger means once status=submitted, payload
// is immutable. We must therefore set status atomically with the
// response — don't try to update payload after dispatch.

import { timingSafeEqual } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'

type QueuedRow = {
  id: string
  document_kind: string
  reference_kind: string
  reference_id: string
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
}

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
  const expected = process.env.EIS_WORKER_SECRET
  if (!expected) {
    throw createError({
      statusCode: 503,
      statusMessage: 'EIS_WORKER_SECRET not configured',
    })
  }
  if (!bearerAuthorized(auth, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const body = (await readBody(event).catch(() => ({}))) as { batch_size?: number }
  const batchSize = Math.min(Math.max(body.batch_size ?? 20, 1), 100)

  const admin = getServerSupabaseAdmin()
  const startedAt = Date.now()

  // Provider config: env vars win, platform_settings fills gaps.
  // Both empty = noop mode.
  let providerUrl = process.env.EIS_PROVIDER_URL ?? ''
  let providerToken = process.env.EIS_PROVIDER_TOKEN ?? ''
  if (!providerUrl || !providerToken) {
    const { data: cfg } = await (admin as any).rpc('get_platform_setting', {
      p_key: 'eis_provider',
    })
    if (cfg && typeof cfg === 'object') {
      if (!providerUrl && typeof cfg.url === 'string') providerUrl = cfg.url
      if (!providerToken && typeof cfg.token === 'string') providerToken = cfg.token
    }
  }
  const isNoop = !providerUrl || !providerToken

  // Claim queued rows. We don't have a SKIP LOCKED helper for
  // eis_submissions (yet), so we read + flip-to-submitted in two
  // statements; concurrent runners would race. For now there's only
  // one cron-runner so this is fine.
  const { data: rows, error: claimErr } = await (admin as any)
    .from('eis_submissions')
    .select('id, document_kind, reference_kind, reference_id, payload, metadata')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(batchSize)
  if (claimErr) {
    throw createError({ statusCode: 500, statusMessage: claimErr.message })
  }

  let submitted = 0
  let accepted = 0
  let rejected = 0
  let failed = 0

  for (const row of (rows ?? []) as QueuedRow[]) {
    if (isNoop) {
      // Noop: stamp submitted, mark provider-not-configured.
      const { error } = await (admin as any)
        .from('eis_submissions')
        .update({
          status: 'submitted',
          submitted_at: new Date().toISOString(),
          response_notes: 'noop provider — EIS_PROVIDER_URL not configured',
          metadata: { ...(row.metadata ?? {}), noop_provider: true },
        })
        .eq('id', row.id)
        .eq('status', 'queued')
      if (error) {
        failed += 1
        logger.warn(
          { err: error.message, row_id: row.id, op: 'eis.noop' },
          'eis_submit_failed',
        )
        continue
      }
      submitted += 1
      continue
    }

    // Live mode.
    let resStatus: 'accepted' | 'rejected' = 'rejected'
    let externalRef: string | null = null
    let notes = ''
    try {
      const res = await fetch(providerUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${providerToken}`,
        },
        body: JSON.stringify(row.payload),
      })
      const text = await res.text().catch(() => '')
      let parsed: any = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      if (res.ok) {
        resStatus = 'accepted'
        externalRef = parsed?.tracking_id ?? parsed?.id ?? null
        notes = (typeof parsed?.message === 'string' ? parsed.message : '').slice(0, 500)
      } else {
        resStatus = 'rejected'
        notes = (
          (typeof parsed?.error === 'string' ? parsed.error : null) ??
          text.slice(0, 500) ??
          `EIS ${res.status}`
        )
      }
    } catch (err: any) {
      // Network / DNS / timeout — record failed but keep status as
      // queued so the next tick retries (don't auto-reject just
      // because BIR sandbox blipped).
      logger.warn(
        { err: err?.message, row_id: row.id, op: 'eis.live' },
        'eis_provider_unreachable',
      )
      failed += 1
      continue
    }

    const { error } = await (admin as any)
      .from('eis_submissions')
      .update({
        status: resStatus,
        submitted_at: new Date().toISOString(),
        external_reference: externalRef,
        response_notes: notes,
      })
      .eq('id', row.id)
      .eq('status', 'queued')
    if (error) {
      failed += 1
      logger.warn(
        { err: error.message, row_id: row.id, op: 'eis.persist' },
        'eis_submit_persist_failed',
      )
      continue
    }
    submitted += 1
    if (resStatus === 'accepted') accepted += 1
    else rejected += 1
  }

  const stats = {
    claimed: rows?.length ?? 0,
    submitted,
    accepted,
    rejected,
    failed,
    noop: isNoop,
    elapsed_ms: Date.now() - startedAt,
  }

  // Heartbeat — best effort.
  await (admin as any)
    .rpc('record_worker_heartbeat', {
      p_worker_key: 'eis_submitter_tick',
      p_payload: { batch_size: batchSize, ...stats },
    })
    .then(({ error }: { error: any }) => {
      if (error) {
        logger.warn(
          { err: error.message, op: 'eis-worker.heartbeat' },
          'eis_worker_heartbeat_failed',
        )
      }
    })
    .catch((err: any) => {
      logger.warn(
        { err: err?.message, op: 'eis-worker.heartbeat' },
        'eis_worker_heartbeat_failed',
      )
    })

  return { ok: true, stats }
})
