// Internal — drain the listing image ingest queue.
//
// POST /api/internal/listings/process-image-queue
// Auth: x-internal-secret header == INTERNAL_CRON_SECRET. Same
// pattern as /api/admin/webhooks/run-retries.
//
// Behaviour per tick (every 2 min via pg_cron):
//   1. Pull up to BATCH_LIMIT due rows (status pending or
//      failed_temporary, next_attempt_at <= now()).
//   2. For each: mark processing, fetch URL via Node fetch,
//      validate Content-Type + size, upload to S3 with the
//      property-N/image-N convention, INSERT listing_images,
//      mark done.
//   3. On failure: increment attempts, set next_attempt_at with
//      exponential backoff, mark failed_temporary; after 5
//      attempts mark failed_permanent.
//
// Always returns 200 with per-row results in the body so a
// flapping URL doesn't crash the worker.
//
// Defers (out of scope this turn):
// Defers (out of scope this turn):
//   - Watermarking (existing displayed-images endpoint expects pre-watermarked input)
//   - HEAD probe before GET (we just GET; the size cap protects us)
//   - Per-listing image cap

import { timingSafeEqual } from 'node:crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { getS3 } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'
import { requireRole } from '~~/server/utils/rbac'

const BATCH_LIMIT = 25
const MAX_ATTEMPTS = 5
const MAX_BYTES = 25_000_000   // 25 MB on FETCH (we'll resize down)
const FETCH_TIMEOUT_MS = 20_000 // 20s — fail-fast on slow origins
const ALLOWED_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
}

// Display variants. Naming preserves the existing convention so the
// website gallery picker (which keys on `image-{N}-635x423.jpg` /
// `thumbnail-image-...`) renders unchanged.
//   main:      gallery render — 1600px max edge, JPEG q80
//   thumbnail: grid card preview — 635x423 cover-fit
const MAIN_LONG_EDGE = 1600
const THUMB_W = 635
const THUMB_H = 423

function isCronAuthorized(event: any): boolean {
  const secret = (process.env.INTERNAL_CRON_SECRET ?? '').trim()
  if (secret.length === 0) return false
  const provided = (getRequestHeader(event, 'x-internal-secret') ?? '').trim()
  if (provided.length === 0) return false
  const a = Buffer.from(secret, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Backoff schedule by attempt count (1-indexed):
//   1 → 2 min, 2 → 5 min, 3 → 15 min, 4 → 1 hr, 5 → 4 hr, then permanent.
function nextAttemptAtForRetry(attempts: number): Date {
  const minutes = attempts <= 1 ? 2
                : attempts === 2 ? 5
                : attempts === 3 ? 15
                : attempts === 4 ? 60
                : 240
  return new Date(Date.now() + minutes * 60 * 1000)
}

type Row = {
  id: string
  listing_id: number
  source_url: string
  position_hint: number | null
  attempts: number
}

function isSafeImageHost(parsed: URL): boolean {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const h = parsed.hostname.toLowerCase()
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return false
  if (/^127\./.test(h)) return false
  if (/^10\./.test(h)) return false
  if (/^192\.168\./.test(h)) return false
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return false
  if (/^169\.254\./.test(h)) return false
  if (/^fc[0-9a-f]{2}::/i.test(h) || /^fd[0-9a-f]{2}::/i.test(h)) return false
  if (/^fe80::/i.test(h)) return false
  return true
}

async function fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string; ext: string } | { error: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error: 'Invalid URL' }
  }
  if (!isSafeImageHost(parsed)) {
    return { error: 'Disallowed image host' }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(parsed.toString(), { signal: ctrl.signal, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || ''
      if (!loc) return { error: 'Redirect without Location' }
      let redirected: URL
      try {
        redirected = new URL(loc, parsed)
      } catch {
        return { error: 'Invalid redirect target' }
      }
      if (!isSafeImageHost(redirected)) return { error: 'Disallowed redirect host' }
      const res2 = await fetch(redirected.toString(), { signal: ctrl.signal, redirect: 'manual' })
      if (res2.status >= 300 && res2.status < 400) return { error: 'Too many redirects' }
      return processImageResponse(res2)
    }
    return processImageResponse(res)
  } catch (err: any) {
    return { error: err?.name === 'AbortError' ? 'Fetch timeout' : (err?.message || 'Fetch error') }
  } finally {
    clearTimeout(timer)
  }
}

async function processImageResponse(res: Response): Promise<{ bytes: Buffer; contentType: string; ext: string } | { error: string }> {
  if (!res.ok) {
    return { error: `HTTP ${res.status}` }
  }
  const ct = ((res.headers.get('content-type') || '').split(';')[0] ?? '').trim().toLowerCase()
  const ext = ALLOWED_EXT[ct]
  if (!ext) return { error: `Unsupported content-type: ${ct || 'unknown'}` }
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_BYTES) return { error: `Image too large: ${len} bytes` }
  const ab = await res.arrayBuffer()
  if (ab.byteLength > MAX_BYTES) {
    return { error: `Image too large after read: ${ab.byteLength} bytes` }
  }
  return { bytes: Buffer.from(ab), contentType: ct, ext }
}

// Sharp normalization. Standardizes to JPEG quality 80 — keeps the
// gallery component happy (it always picks .jpg if present) and
// shrinks PNGs from photographers that came in 5+ MB. Always
// .rotate() first so EXIF orientation flags become physical
// rotation; otherwise the browser may render rotated then a
// downstream Sharp op (or the gallery thumbnail picker) sees the
// raw-pixel dimensions and gets confused.
async function normalizeMain(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({
      width:           MAIN_LONG_EDGE,
      height:          MAIN_LONG_EDGE,
      fit:             'inside',
      withoutEnlargement: true, // don't upscale tiny photos
    })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer()
}

async function normalizeThumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize(THUMB_W, THUMB_H, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer()
}

async function processRow(row: Row, supabase: any): Promise<{ ok: boolean; reason?: string }> {
  // Mark processing.
  await supabase
    .from('listing_image_ingest_queue')
    .update({ status: 'processing' })
    .eq('id', row.id)

  // Fetch.
  const fetched = await fetchImage(row.source_url)
  if ('error' in fetched) {
    return { ok: false, reason: fetched.error }
  }

  // Sharp pipeline — convert to normalized JPEG for both variants.
  let mainBuf: Buffer
  let thumbBuf: Buffer
  try {
    mainBuf  = await normalizeMain(fetched.bytes)
    thumbBuf = await normalizeThumbnail(fetched.bytes)
  } catch (err: any) {
    return { ok: false, reason: `Sharp normalization failed: ${err?.message || 'unknown'}` }
  }

  // After normalization everything is JPEG. Naming convention from
  // upload-displayed-images.post.ts: first image is named
  // `thumbnail-image-{N}-635x423.jpg`, rest are `image-{N}-635x423.jpg`.
  // We continue to use that naming so the existing gallery picker
  // and CDN URL builders render unchanged.
  const { client, bucket } = getS3()
  const { count: existingCount } = await supabase
    .from('listing_images')
    .select('media_id', { count: 'exact', head: true })
    .eq('listing_id', row.listing_id)
  const idx = (existingCount ?? 0)

  // Two physical objects per ingested image:
  //   image-{N}-1600.jpg          → main display (or thumbnail-image-... for first)
  //   image-{N}-635x423.jpg       → grid thumbnail (or thumbnail-image-... for first)
  const ext = 'jpg'
  const mainBase  = idx === 0
    ? `thumbnail-image-${idx}-1600.jpg`
    : `image-${idx}-1600.jpg`
  const thumbBase = idx === 0
    ? `thumbnail-image-${idx}-635x423.jpg`
    : `image-${idx}-635x423.jpg`
  const mainKey  = `properties/property-${row.listing_id}/${mainBase}`
  const thumbKey = `properties/property-${row.listing_id}/${thumbBase}`

  try {
    await Promise.all([
      client.send(new PutObjectCommand({
        Bucket: bucket, Key: mainKey,  Body: mainBuf,  ContentType: 'image/jpeg',
      })),
      client.send(new PutObjectCommand({
        Bucket: bucket, Key: thumbKey, Body: thumbBuf, ContentType: 'image/jpeg',
      })),
    ])
  } catch (err: any) {
    return { ok: false, reason: `S3 upload failed: ${err?.message || 'unknown'}` }
  }

  // Insert listing_images row. file_name uses the THUMBNAIL base
  // (without extension) because the existing gallery picker keys on
  // `image-{N}-635x423` and derives the larger variant by stripping
  // the dimension suffix. Both files exist in S3.
  const fileNameNoExt = thumbBase.replace(/\.[^.]+$/, '')
  const { error: insErr } = await supabase
    .from('listing_images')
    .insert({
      listing_id:            row.listing_id,
      file_name:             fileNameNoExt,
      no_watermark_filename: fileNameNoExt,
      extension:             ext,
    })
  if (insErr) {
    return { ok: false, reason: `listing_images insert: ${insErr.message}` }
  }

  // Stamp success on the queue row.
  await supabase
    .from('listing_image_ingest_queue')
    .update({
      status:             'done',
      processed_at:       new Date().toISOString(),
      resolved_file_name: thumbBase,
      resolved_extension: ext,
      bytes_downloaded:   fetched.bytes.length,
      content_type:       'image/jpeg',
      last_error:         null,
    })
    .eq('id', row.id)

  return { ok: true }
}

export default defineEventHandler(async (event) => {
  // Dual-auth: cron secret OR admin JWT for manual runs.
  let authorized = isCronAuthorized(event)
  if (!authorized) {
    try {
      await requireRole(event, 'admin')
      authorized = true
    } catch {
      authorized = false
    }
  }
  if (!authorized) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const supabase = getServerSupabaseAdmin()

  // Pull a batch of due rows.
  const { data: rows, error: pullErr } = await (supabase as any)
    .from('listing_image_ingest_queue')
    .select('id, listing_id, source_url, position_hint, attempts')
    .in('status', ['pending', 'failed_temporary'])
    .lte('next_attempt_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (pullErr) {
    logger.error({ err: pullErr.message, op: 'image_queue.pull' }, 'image_queue_pull_failed')
    throw createError({ statusCode: 500, statusMessage: pullErr.message })
  }

  const results = {
    pulled:    rows?.length ?? 0,
    done:      0,
    failed_temp: 0,
    failed_permanent: 0,
    errors:    [] as Array<{ id: string; error: string }>,
  }

  for (const row of (rows ?? []) as Row[]) {
    const out = await processRow(row, supabase).catch((err: any) => ({
      ok: false, reason: err?.message || 'unhandled',
    }))
    if (out.ok) {
      results.done += 1
      continue
    }

    const nextAttempts = (row.attempts ?? 0) + 1
    if (nextAttempts >= MAX_ATTEMPTS) {
      await (supabase as any)
        .from('listing_image_ingest_queue')
        .update({
          status:       'failed_permanent',
          attempts:     nextAttempts,
          last_error:   out.reason ?? 'unknown',
          processed_at: new Date().toISOString(),
        })
        .eq('id', row.id)
      results.failed_permanent += 1
    } else {
      await (supabase as any)
        .from('listing_image_ingest_queue')
        .update({
          status:          'failed_temporary',
          attempts:        nextAttempts,
          last_error:      out.reason ?? 'unknown',
          next_attempt_at: nextAttemptAtForRetry(nextAttempts).toISOString(),
        })
        .eq('id', row.id)
      results.failed_temp += 1
    }
    results.errors.push({ id: row.id, error: out.reason ?? 'unknown' })
  }

  return results
})
