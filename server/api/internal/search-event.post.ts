// Internal — record a hybrid-search telemetry event.
//
// POST /api/internal/search-event
// Auth: x-internal-secret header matching INTERNAL_CRON_SECRET.
//
// The website's hybrid orchestrator fires-and-forgets one of these per
// user query. Writes to search_events via the SECURITY DEFINER RPC so
// the caller doesn't need direct INSERT grants on the table. Telemetry
// must NEVER block the user response — this endpoint runs with a tight
// timeout on the caller side.

import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  request_origin: z.enum(['website', 'portal', 'api']).default('website'),
  user_id: z.string().uuid().nullable().optional(),
  ip_hash: z.string().max(80).nullable().optional(),
  query_input: z.record(z.string(), z.any()).default({}),
  query_hash: z.string().max(80),
  internal_count: z.coerce.number().int().min(0).default(0),
  external_count: z.coerce.number().int().min(0).default(0),
  merged_count: z.coerce.number().int().min(0).default(0),
  dedup_collapses: z.coerce.number().int().min(0).default(0),
  internal_ms: z.coerce.number().int().min(0).nullable().optional(),
  external_ms: z.coerce.number().int().min(0).nullable().optional(),
  total_ms: z.coerce.number().int().min(0).nullable().optional(),
  provider_breakdown: z.record(z.string(), z.any()).default({}),
  degraded: z.boolean().default(false),
  notes: z.string().max(500).nullable().optional(),
})

function authorized(provided: string | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided.trim(), 'utf8')
  const b = Buffer.from(expected.trim(), 'utf8')
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default defineEventHandler(async (event) => {
  const expected = process.env.INTERNAL_CRON_SECRET
  const provided = getRequestHeader(event, 'x-internal-secret')
  if (!authorized(provided, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const parsed = bodySchema.safeParse((await readBody(event)) ?? {})
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Invalid body',
      data: { issues: parsed.error.issues },
    })
  }
  const b = parsed.data

  const supabase = getServerSupabaseAdmin()
  const { data, error } = await (supabase as any).rpc('record_search_event', {
    p_request_origin:     b.request_origin,
    p_user_id:            b.user_id ?? null,
    p_ip_hash:            b.ip_hash ?? null,
    p_query_input:        b.query_input,
    p_query_hash:         b.query_hash,
    p_internal_count:     b.internal_count,
    p_external_count:     b.external_count,
    p_merged_count:       b.merged_count,
    p_dedup_collapses:    b.dedup_collapses,
    p_internal_ms:        b.internal_ms ?? null,
    p_external_ms:        b.external_ms ?? null,
    p_total_ms:           b.total_ms ?? null,
    p_provider_breakdown: b.provider_breakdown,
    p_degraded:           b.degraded,
    p_notes:              b.notes ?? null,
  })
  if (error) {
    // Logged but the response stays 200 — telemetry must never error
    // upstream.
    logger.warn(
      { err: error.message, op: 'search-event.write' },
      'search_event_write_failed',
    )
    return { ok: false }
  }
  return { ok: true, id: data ?? null }
})
