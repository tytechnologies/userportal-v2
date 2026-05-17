// Upload watermarked (displayed-size) images for a listing.
//
// Hardening:
//   - listingId coerced to int + RLS-checked via assertCanWriteListing.
//   - Each image's extension is taken from the validated decodeDataUrl
//     output (not the client-supplied `image.extension` field), so the
//     ContentType header always matches the actual decoded bytes.
//   - File-type whitelist limits storage to png/jpg/jpeg/webp.
//   - Size cap (15 MB per image, 30 images per request).

import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getS3, listObjectsByPrefix, decodeDataUrl } from '~~/server/utils/s3'
import { assertCanWriteListing } from '~~/server/utils/images-auth'

const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp'])
const MAX_IMAGES = 30
const MAX_DATAURL_BYTES = 15_000_000

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const body = await readBody(event).catch(() => ({} as any))
    const id = await assertCanWriteListing(event, body?.listingId)
    const images = Array.isArray(body?.images) ? body.images : null

    if (!images || images.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'images array is required' })
    }
    if (images.length > MAX_IMAGES) {
      throw createError({ statusCode: 422, statusMessage: `Too many images (max ${MAX_IMAGES})` })
    }

    const { client, bucket } = getS3()
    const prefix = `properties/property-${id}/`

    const existing = await listObjectsByPrefix(prefix).catch(() => [])
    const existingImageCount = existing.filter((obj) => {
      const fileName = obj.Key?.split('/').pop() ?? ''
      return fileName.includes('image-') || fileName.includes('thumbnail-')
    }).length

    const uploadedUrls = await Promise.all(
      images.map(async (image: any, index: number) => {
        if (typeof image?.dataUrl !== 'string' || image.dataUrl.length > MAX_DATAURL_BYTES) {
          throw createError({ statusCode: 422, statusMessage: 'Invalid or oversized image payload' })
        }
        // Extension comes from the validated MIME, not the client field.
        const { extension, body: buffer } = decodeDataUrl(image.dataUrl)
        if (!ALLOWED_EXT.has(extension)) {
          throw createError({
            statusCode: 422,
            statusMessage: `Unsupported image type: ${extension}`,
          })
        }
        const globalIndex = existingImageCount + index
        const fileName =
          index === 0
            ? `thumbnail-image-${globalIndex}-635x423.${extension}`
            : `image-${globalIndex}-635x423.${extension}`
        const keyPath = `property-${id}/${fileName}`

        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `properties/${keyPath}`,
            Body: buffer,
            ContentType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
          }),
        )

        return {
          url: `${bucket}/${fileName}`,
          key: keyPath,
          file_name: fileName,
          globalIndex,
          isThumbnail: image.thumbnail || index === 0,
        }
      }),
    )

    return {
      success: true,
      uploadedUrls,
      existingImageCount,
      newImagesCount: images.length,
      totalImageCount: existingImageCount + images.length,
    }
  },
})
