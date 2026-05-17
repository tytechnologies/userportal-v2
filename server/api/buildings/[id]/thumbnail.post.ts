// Upload a thumbnail image for a building. Editor sends a base64 data
// URL (PNG/JPG); we decode + store at buildings/<id>/thumbnail.<ext>
// in the same bucket as listings. Public website signs from there.
//
// Auth + permission: requires buildings.manage (admin/manager role).
// Anyone with editor access to a building can replace its thumbnail.

import { z } from 'zod'
import { decodeDataUrl, uploadObject, deleteObjectsByPrefix } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'
import { assertCanWriteBuilding } from '~~/server/utils/images-auth'

const bodySchema = z.object({
  /** Data URL — `data:image/<png|jpg|webp>;base64,<...>`. */
  data_url: z.string().min(20).max(15_000_000),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    // Gates on `buildings.manage` (admin / manager). The S3 prefix
    // doesn't go through the buildings table, so RLS would otherwise
    // not protect this endpoint.
    const id = await assertCanWriteBuilding(event, getRouterParam(event, 'id'))

    const { extension, body: imageBody } = decodeDataUrl(body.data_url)
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
      throw createError({ statusCode: 422, statusMessage: 'Only PNG / JPG / WEBP supported' })
    }

    // Clear previous thumbnail(s) — there should only be one but the
    // prefix sweep guards against ext changes (jpg → webp).
    try {
      await deleteObjectsByPrefix(`buildings/${id}/`)
    } catch (err: any) {
      logger.warn({ err: err?.message, building_id: id, op: 'buildings.thumbnail.cleanup' }, 'building_thumbnail_cleanup_failed')
    }

    const key = `buildings/${id}/thumbnail.${extension}`
    try {
      await uploadObject(key, imageBody)
    } catch (err: any) {
      logger.error({ err: err?.message, building_id: id, op: 'buildings.thumbnail.upload' }, 'building_thumbnail_upload_failed')
      throw createError({ statusCode: 500, statusMessage: 'Failed to upload thumbnail' })
    }

    return { success: true, key }
  },
})
