import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { getS3 } from '~~/server/utils/s3'
import { assertCanWriteListing } from '~~/server/utils/images-auth'

async function updateThumbnailInPrefix(
  s3: S3Client,
  bucket: string,
  prefix: string,
  /**
   * Selector for which S3 object becomes the new thumbnail.
   *  - imageIndex: 0-based array position embedded in the filename
   *    pattern `image-<i>-`. This is what the uploader writes.
   *  - key: full S3 key (e.g. when the operator picked an existing
   *    image via the wizard's edit-mode flow).
   */
  selector: { imageIndex?: number; key?: string },
) {
  const listResponse = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
  const objects = listResponse.Contents || []

  let currentThumbnail: { Key: string } | null = null
  let newThumbnail: { Key: string } | null = null

  for (const obj of objects) {
    if (!obj.Key) continue
    const fileName = obj.Key.split('/').pop() || ''
    if (fileName.includes('thumbnail-')) {
      currentThumbnail = obj as { Key: string }
    } else if (selector.key && obj.Key === selector.key) {
      newThumbnail = obj as { Key: string }
    } else if (selector.imageIndex != null) {
      const match = fileName.match(/image-(\d+)-/)
      if (match && match[1] && parseInt(match[1], 10) === selector.imageIndex) {
        newThumbnail = obj as { Key: string }
      }
    }
  }

  if (!newThumbnail) {
    const availableIndices = objects
      .map((obj) => {
        const match = obj.Key?.split('/').pop()?.match(/image-(\d+)-/)
        return match && match[1] ? parseInt(match[1], 10) : null
      })
      .filter((n): n is number => n != null)
    // 422 (not 404) — the route + listing exist; we just couldn't find
    // a matching S3 object. Structured body so the wizard can show a
    // meaningful error rather than "Not Found".
    throw createError({
      statusCode: 422,
      statusMessage: 'image_not_found_in_prefix',
      data: {
        error: 'image_not_found',
        prefix,
        selector,
        available_image_indices: availableIndices,
        hint: selector.imageIndex != null
          ? `No file matches image-${selector.imageIndex}- in ${prefix}. Pass an index from available_image_indices.`
          : `Key "${selector.key}" not present under ${prefix}.`,
      },
    })
  }

  const results: { currentThumbnail: any; newThumbnail: any; success: boolean } = {
    currentThumbnail: null,
    newThumbnail: null,
    success: false,
  }

  if (currentThumbnail) {
    const currentFileName = currentThumbnail.Key.split('/').pop() || ''
    const newFileName = currentFileName.replace('thumbnail-', '')
    const newKey = `${prefix}${newFileName}`

    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${currentThumbnail.Key}`,
        Key: newKey,
      }),
    )
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: [{ Key: currentThumbnail.Key }] },
      }),
    )
    results.currentThumbnail = {
      oldKey: currentThumbnail.Key,
      newKey,
      oldFileName: currentFileName,
      newFileName,
    }
  }

  const newThumbnailFileName = newThumbnail.Key.split('/').pop() || ''
  const thumbnailFileName = `thumbnail-${newThumbnailFileName}`
  const thumbnailKey = `${prefix}${thumbnailFileName}`

  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${newThumbnail.Key}`,
      Key: thumbnailKey,
    }),
  )
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: [{ Key: newThumbnail.Key }] },
    }),
  )
  results.newThumbnail = {
    oldKey: newThumbnail.Key,
    newKey: thumbnailKey,
    oldFileName: newThumbnailFileName,
    newFileName: thumbnailFileName,
  }
  results.success = true
  return results
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const body = await readBody(event)
    // assertCanWriteListing coerces to int + RLS-checks; throws 400/404
    // on bad input or hidden row.
    const id = await assertCanWriteListing(event, body?.listingId)

    // Selector — prefer the new explicit names (`imageIndex` / `key`)
    // but accept the legacy `newThumbnailImageId` so existing callers
    // (listing.services._updateThumbnailSelection, imagesController,
    // originalImagesController) keep working.
    const rawIndex =
      body?.imageIndex ?? body?.newThumbnailImageId ?? null
    const explicitKey =
      typeof body?.key === 'string' && body.key.trim() !== ''
        ? body.key.trim()
        : null

    let imageIndex: number | undefined
    if (rawIndex != null) {
      const parsed =
        typeof rawIndex === 'number' ? rawIndex : parseInt(rawIndex, 10)
      if (Number.isNaN(parsed) || parsed < 0) {
        throw createError({
          statusCode: 400,
          statusMessage: 'imageIndex must be a non-negative number',
          data: { error: 'invalid_image_index' },
        })
      }
      imageIndex = parsed
    }

    if (imageIndex == null && !explicitKey) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Provide either imageIndex or key',
        data: { error: 'missing_selector' },
      })
    }

    const selector = { imageIndex, key: explicitKey ?? undefined }
    const { client: s3, bucket } = getS3()

    const [displayed, original] = await Promise.all([
      updateThumbnailInPrefix(
        s3,
        bucket,
        `properties/property-${id}/`,
        selector,
      ),
      updateThumbnailInPrefix(
        s3,
        bucket,
        `properties/original/property-${id}/`,
        selector,
      ),
    ])

    return { success: true, displayed, original }
  },
})
