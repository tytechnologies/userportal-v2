// Internal — drains the listings_raw → listings_normalized pipeline.
//
// POST /api/internal/normalize-raw-batch
// Auth: x-internal-secret header matching INTERNAL_CRON_SECRET in vault.
//
// Pings the normalize_listings_raw_batch RPC, which is the actual
// worker. Same pattern as listing_image_ingest_queue's process
// endpoint (mig 507000040): pg_cron POSTs here every 2 minutes, the
// endpoint runs as service-role (bypasses RLS), the RPC does the
// work in-DB and returns counts.

import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  max: z.coerce.number().int().min(1).max(2000).optional(),
})

function isInternalSecretAuthorized(
  provided: string | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided.trim(), 'utf8')
  const b = Buffer.from(expected.trim(), 'utf8')
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const expected = (config.internalCronSecret as string | undefined)
    ?? process.env.INTERNAL_CRON_SECRET
  const provided = getRequestHeader(event, 'x-internal-secret')

  if (!isInternalSecretAuthorized(provided, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  let body: z.infer<typeof bodySchema> = {}
  try {
    const raw = await readBody(event)
    body = bodySchema.parse(raw ?? {})
  } catch {
    body = {}
  }

  const supabase = await serverSupabaseClient(event)
  const { data, error } = await (supabase as any).rpc('normalize_listings_raw_batch', {
    p_max: body.max ?? 200,
  })
  if (error) {
    logger.error(
      { err: error.message, op: 'internal.normalize_raw_batch' },
      'normalize_worker_failed',
    )
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return { ok: true, result: data?.[0] ?? data ?? null }
})
