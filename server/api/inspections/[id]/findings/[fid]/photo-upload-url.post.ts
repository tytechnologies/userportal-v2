// Presign a PUT URL for an inspection photo upload.
//
// POST /api/inspections/[id]/findings/[fid]/photo-upload-url
// Body: { content_type: string, byte_length?: number, filename?: string }
//
// Returns: { key, upload_url, expires_at, public_path }
//
// Client flow:
//   1. POST here with the file's MIME + (optional) byte_length.
//   2. PUT the file body directly to upload_url with the same
//      Content-Type header. NO Authorization header — the URL is
//      already signed.
//   3. Append { key, name } to the finding's photos[] via PATCH
//      /api/inspections/[id]/findings/[fid].
//   4. Display: the next GET /api/inspections/[id] returns each photo
//      enriched with `display_url` (signed download URL with 1-hour TTL).
//
// Server doesn't see the file body — bypassing Nitro keeps large
// uploads off our server CPU + bandwidth budget.

import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { getSignedUploadUrl, getS3 } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
])

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

const bodySchema = z.object({
  content_type: z.string().trim().toLowerCase(),
  byte_length: z.number().int().min(1).max(20 * 1024 * 1024).optional(),
  filename: z.string().trim().max(200).optional(),
})

const PRESIGN_TTL_SECONDS = 600 // 10 minutes
// Cap browser-side; presigned URL doesn't enforce content-length-range
// in this v1, so this is advisory. Tighten via S3 bucket policy if abuse
// is observed.
const SIZE_LIMIT_HUMAN = '20 MB'

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const inspectionId = getRouterParam(event, 'id')
    const findingId = getRouterParam(event, 'fid')
    if (!inspectionId || !/^[0-9a-f-]{36}$/i.test(inspectionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid inspection id' })
    }
    if (!findingId || !/^[0-9a-f-]{36}$/i.test(findingId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid finding id' })
    }

    if (!ALLOWED_MIME.has(body.content_type)) {
      throw createError({
        statusCode: 422,
        statusMessage: `content_type must be one of: ${Array.from(ALLOWED_MIME).join(', ')}`,
      })
    }
    if (body.byte_length && body.byte_length > 20 * 1024 * 1024) {
      throw createError({
        statusCode: 422,
        statusMessage: `byte_length exceeds ${SIZE_LIMIT_HUMAN}`,
      })
    }

    // Verify parent inspection is mutable + finding belongs to it.
    // Reusing the existing finding-edit gate so URLs aren't issued
    // for completed/signed/cancelled inspections.
    const admin = getServerSupabaseAdmin()
    const { data: parent, error: parentErr } = await (admin as any)
      .from('inspections')
      .select('id, status')
      .eq('id', inspectionId)
      .maybeSingle()
    if (parentErr) {
      throw createError({ statusCode: 500, statusMessage: parentErr.message })
    }
    if (!parent) {
      throw createError({ statusCode: 404, statusMessage: 'Inspection not found' })
    }
    if (!['scheduled', 'in_progress'].includes(parent.status)) {
      throw createError({
        statusCode: 409,
        statusMessage: `Cannot upload photos on inspection in status=${parent.status}`,
      })
    }
    const { data: finding, error: findingErr } = await (admin as any)
      .from('inspection_findings')
      .select('id')
      .eq('id', findingId)
      .eq('inspection_id', inspectionId)
      .maybeSingle()
    if (findingErr) {
      throw createError({ statusCode: 500, statusMessage: findingErr.message })
    }
    if (!finding) {
      throw createError({ statusCode: 404, statusMessage: 'Finding not found' })
    }

    // Build the key. Per-finding sub-folder makes deletion easy:
    // operator deletes the finding → batch delete the prefix.
    const ext = EXT_BY_MIME[body.content_type] ?? 'bin'
    const key = `inspections/inspection-${inspectionId}/findings/${findingId}/${randomUUID()}.${ext}`

    let upload_url: string
    try {
      upload_url = await getSignedUploadUrl(key, body.content_type, PRESIGN_TTL_SECONDS)
    } catch (err: any) {
      logger.error(
        { err: err?.message, op: 'admin.inspections.photo_upload_url' },
        'inspection_photo_presign_failed',
      )
      throw createError({
        statusCode: err?.statusCode ?? 500,
        statusMessage: err?.statusMessage ?? 'Could not generate upload URL',
      })
    }

    const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString()
    // Public path is informational — the bucket isn't anonymously
    // readable, so the actual display flow uses signed download URLs.
    // Returning the key shape lets the client surface a stable
    // identifier in the UI before the photo is actually written.
    const { bucketUrl } = getS3()

    return {
      key,
      upload_url,
      expires_at: expiresAt,
      content_type: body.content_type,
      // Filename hint preserved for the UI chip label.
      filename: body.filename ?? key.split('/').pop(),
      public_path: `${bucketUrl}/${key}`,
    }
  },
})
