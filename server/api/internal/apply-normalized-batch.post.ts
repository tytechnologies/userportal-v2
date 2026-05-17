// Internal — drain listings_normalized → listings (B-3.1 apply worker).
//
// POST /api/internal/apply-normalized-batch
// Auth: x-internal-secret header matching INTERNAL_CRON_SECRET.
//
// Calls apply_listings_normalized_batch RPC. Same pattern as
// /api/internal/normalize-raw-batch: pg_cron POSTs here every N
// minutes, the endpoint runs as service-role (bypasses RLS), the
// RPC does the work in-DB and returns per-pass counts.
//
// Operating mode: SHADOW. The direct ingest path into listings is
// still active; this worker writes the same data via the normalized
// chain. Both paths must converge — staleness + collision guards in
// the RPC make this safe under dual-write.

import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  max: z.coerce.number().int().min(1).max(2000).optional(),
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

  let body: z.infer<typeof bodySchema> = {}
  try { body = bodySchema.parse((await readBody(event)) ?? {}) } catch {}

  const supabase = await serverSupabaseClient(event)
  const { data, error } = await (supabase as any).rpc(
    'apply_listings_normalized_batch',
    { p_max: body.max ?? 200 },
  )
  if (error) {
    logger.error(
      { err: error.message, op: 'internal.apply_normalized_batch' },
      'apply_worker_failed',
    )
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return { ok: true, result: data?.[0] ?? data ?? null }
})
