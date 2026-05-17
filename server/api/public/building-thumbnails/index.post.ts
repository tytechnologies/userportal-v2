// Public anon-readable building thumbnail endpoint.
//
// Used by the public website's /buildings cards. Body shape:
//   { building_ids: number[] } — a batch lookup so a list page does
//   one round-trip instead of N. Up to 100 ids per call.
//
// Returns a map keyed by building_id with a single signed URL each
// (the first object found under buildings/<id>/), or null when no
// images are present yet:
//
//   { thumbnails: { "1196": "https://.../signed", "555": null, ... } }
//
// 7-day signed URLs match the website agent's spec.
//
// No auth required — this is the public site's read path. Rate limit
// at the edge (Cloudflare WAF) the same way as /api/public/inquiries.

import { z } from 'zod'
import { defineEventHandler, createError, readBody } from 'h3'
import { ZodError } from 'zod'
import { listObjectsByPrefix, getSignedDownloadUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { clientIp, enforceRateLimit } from '~~/server/utils/rate-limit'

const bodySchema = z.object({
  building_ids: z.array(z.number().int().positive()).min(1).max(100),
})

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const THUMBNAIL_RATE_LIMIT_MAX = 60
const THUMBNAIL_RATE_LIMIT_WINDOW = 60 // seconds

export default defineEventHandler(async (event) => {
  try {
    await enforceRateLimit({
      event,
      client: getServerSupabaseAdmin(),
      key: `building-thumbnails:${clientIp(event)}`,
      max: THUMBNAIL_RATE_LIMIT_MAX,
      windowSeconds: THUMBNAIL_RATE_LIMIT_WINDOW,
    })
  } catch (err: any) {
    if (err?.statusCode === 429) throw err
    logger.warn(
      { err: err?.message, op: 'public.building_thumbnails.rate_limit' },
      'building_thumbnail_rate_limit_failed',
    )
  }

  let body: z.infer<typeof bodySchema>
  try {
    const raw = await readBody(event)
    body = bodySchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Validation failed',
        data: { issues: err.issues },
      })
    }
    throw err
  }

  // Resolve each id in parallel. Pick the lexicographically-first
  // object under buildings/<id>/ as the thumbnail; the website doesn't
  // care which photo, only that there is one.
  const thumbnails: Record<string, string | null> = {}

  await Promise.all(
    body.building_ids.map(async (id) => {
      try {
        const objects = await listObjectsByPrefix(`buildings/${id}/`)
        const candidate = (objects ?? [])
          .filter((o: any) => o?.Key)
          // S3 returns sorted lexically by default; first usable object
          // is the consistent pick across calls.
          .sort((a: any, b: any) => String(a.Key).localeCompare(String(b.Key)))[0]
        if (candidate?.Key) {
          thumbnails[String(id)] = await getSignedDownloadUrl(candidate.Key, SIGNED_URL_TTL_SECONDS)
        } else {
          thumbnails[String(id)] = null
        }
      } catch (err: any) {
        logger.warn(
          { err: err?.message, building_id: id, op: 'public.building_thumbnails' },
          'building_thumbnail_lookup_failed',
        )
        thumbnails[String(id)] = null
      }
    }),
  )

  return { thumbnails }
})
