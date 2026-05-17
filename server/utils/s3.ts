import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { logger } from './logger'

let cached: { client: S3Client; bucket: string; region: string; bucketUrl: string } | null = null

export const getS3 = () => {
  if (cached) return cached
  const config = useRuntimeConfig()
  const region = (config.public.AWS_REGION as string) || ''
  const bucket = (config.public.S3_BUCKET_NAME as string) || ''
  const accessKeyId = (config.AWS_ACCESS_KEY_ID as string) || ''
  const secretAccessKey = (config.AWS_SECRET_ACCESS_KEY as string) || ''

  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'S3 is not configured',
    })
  }

  cached = {
    client: new S3Client({ region, credentials: { accessKeyId, secretAccessKey } }),
    bucket,
    region,
    bucketUrl: `https://${bucket}.s3.${region}.amazonaws.com`,
  }
  return cached
}

const dataUrlPattern = /^data:image\/(\w+);base64,/

export const decodeDataUrl = (dataUrl: string) => {
  const match = dataUrl.match(dataUrlPattern)
  if (!match) {
    throw createError({ statusCode: 422, statusMessage: 'Invalid image data URL' })
  }
  const extension = match[1]!.toLowerCase()
  const base64 = dataUrl.replace(dataUrlPattern, '')
  return { extension, body: Buffer.from(base64, 'base64') }
}

export const uploadObject = async (key: string, body: Buffer | Uint8Array) => {
  const { client, bucket, bucketUrl } = getS3()
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }))
  return `${bucketUrl}/${key}`
}

export const deleteObjectsByPrefix = async (prefix: string) => {
  const { client, bucket } = getS3()
  const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
  const objects = list.Contents ?? []
  if (objects.length === 0) return 0

  for (const object of objects) {
    if (!object.Key) continue
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }))
  }
  logger.debug({ prefix, count: objects.length }, 's3_prefix_deleted')
  return objects.length
}

export const uploadContactAvatar = async (contactId: number | string, dataUrl: string) => {
  const { extension, body } = decodeDataUrl(dataUrl)
  const key = `contacts/contact-${contactId}/avatar/avatar.${extension}`
  return uploadObject(key, body)
}

export const deleteListingImages = async (listingId: number | string) => {
  const watermarked = await deleteObjectsByPrefix(`properties/property-${listingId}/`)
  const originals = await deleteObjectsByPrefix(`properties/original/property-${listingId}/`)
  return { watermarked, originals, total: watermarked + originals }
}

export const listObjectsByPrefix = async (prefix: string) => {
  const { client, bucket } = getS3()
  const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
  return response.Contents ?? []
}

// 1 hour. Long enough for a page session + a refresh, short enough that
// a leaked URL (logs, screenshots, browser sync) expires same-day.
// Public-website batch endpoint passes its own longer TTL explicitly.
export const getSignedDownloadUrl = async (key: string, expiresIn = 3_600) => {
  const { client, bucket } = getS3()
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn })
}

// Presigned PUT URL for direct browser → S3 uploads. Used by surfaces
// that want to bypass the Nitro server for large bodies (inspection
// photos, future document uploads). Caller should hold the URL only
// long enough to PUT the file; default 10-minute TTL is plenty for
// the typical upload but short enough to limit replay if leaked.
//
// `contentType` is REQUIRED — clients PUT with a matching Content-Type
// header so S3 stores the right MIME (browser preview / signed-display
// pipeline relies on it).
export const getSignedUploadUrl = async (
  key: string,
  contentType: string,
  expiresIn = 600,
) => {
  const { client, bucket } = getS3()
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  )
}

export const getContactAvatarUrls = async (contactId: number | string) => {
  const objects = await listObjectsByPrefix(`contacts/contact-${contactId}/avatar/`)
  const urls: string[] = []
  for (const obj of objects) {
    if (!obj.Key) continue
    urls.push(await getSignedDownloadUrl(obj.Key))
  }
  return urls
}

const signedUrlsForPrefix = async (prefix: string) => {
  const objects = await listObjectsByPrefix(prefix)
  const out: { object: typeof objects[number]; signedUrl: string }[] = []
  for (const object of objects) {
    if (!object.Key) continue
    const signedUrl = await getSignedDownloadUrl(object.Key)
    out.push({ object, signedUrl })
  }
  return out
}

export const getListingDisplayedImageUrls = (listingId: number | string) =>
  signedUrlsForPrefix(`properties/property-${listingId}/`)

export const getListingOriginalImageUrls = (listingId: number | string) =>
  signedUrlsForPrefix(`properties/original/property-${listingId}/`)

// Image extensions we accept as listing thumbnails. Filters out PDFs,
// stray .txt files, and pre-encode HEIC sources that occasionally land
// in the prefix.
const LISTING_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']

const isListingImageKey = (key: string | undefined): boolean => {
  if (!key) return false
  const lower = key.toLowerCase()
  return LISTING_IMAGE_EXTS.some((ext) => lower.endsWith(ext))
}

/**
 * Pick a single thumbnail S3 key for the listings table / card grid.
 *
 * Selection order (highest-confidence first):
 *   1. Canonical `thumbnail-*` filename — what the upload pipeline emits
 *      for the official thumbnail variant. Preserved as preferred so
 *      curated thumbs stay deterministic across sessions.
 *   2. Anything inside a `thumbnail/` subdirectory — older layout.
 *   3. RANDOM pick from any remaining image in the prefix. Covers
 *      legacy / direct-uploaded listings whose images don't follow the
 *      canonical naming so the card surfaces SOMETHING instead of
 *      falling through to the placeholder.
 *
 * Random is deliberate (per product ask): if a listing has 8 photos but
 * no thumbnail-named one, the table cell shouldn't always pick photo[0]
 * — rotating between page loads gives the directory a "live" feel.
 * Within a single browser session the thumbnailStore caches the first
 * result, so the card stays stable while a user is browsing.
 */
export const getListingThumbnailUrl = async (listingId: number | string) => {
  const objects = await listObjectsByPrefix(`properties/property-${listingId}/`)
  const images = objects.filter((o) => isListingImageKey(o.Key))
  if (images.length === 0) return null

  const canonical = images.find((o) => o.Key?.split('/').pop()?.includes('thumbnail-'))
  if (canonical?.Key) return getSignedDownloadUrl(canonical.Key)

  const inThumbnailDir = images.find((o) => o.Key?.includes('/thumbnail/'))
  if (inThumbnailDir?.Key) return getSignedDownloadUrl(inThumbnailDir.Key)

  const pick = images[Math.floor(Math.random() * images.length)]
  if (!pick?.Key) return null
  return getSignedDownloadUrl(pick.Key)
}

const cloneObjectsByPrefix = async (sourcePrefix: string, targetPrefix: string) => {
  const { client, bucket } = getS3()
  const objects = await listObjectsByPrefix(sourcePrefix)
  const results = await Promise.all(
    objects.map(async (object) => {
      if (!object.Key) return { sourceKey: '', targetKey: '', success: false }
      const fileName = object.Key.split('/').pop()
      const targetKey = `${targetPrefix}${fileName}`
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${object.Key}`,
            Key: targetKey,
          }),
        )
        return { sourceKey: object.Key, targetKey, success: true }
      } catch (err) {
        logger.error({ err: (err as Error).message, sourceKey: object.Key }, 's3_copy_failed')
        return { sourceKey: object.Key, targetKey, success: false }
      }
    }),
  )
  const successful = results.filter((r) => r.success).length
  return { total: objects.length, successful, failed: objects.length - successful, results }
}

export const cloneListingImages = async (
  sourceId: number | string,
  targetId: number | string,
) => {
  const displayed = await cloneObjectsByPrefix(
    `properties/property-${sourceId}/`,
    `properties/property-${targetId}/`,
  )
  const original = await cloneObjectsByPrefix(
    `properties/original/property-${sourceId}/`,
    `properties/original/property-${targetId}/`,
  )
  return { displayed, original }
}

export const searchViewingListsByName = async (searchString: string) => {
  const trimmed = (searchString ?? '').trim()
  if (!trimmed) return []
  const objects = await listObjectsByPrefix('documents/Viewing Lists/')
  const lower = trimmed.toLowerCase()
  const matching = objects.filter((obj) => obj.Key?.toLowerCase().includes(lower))
  if (matching.length === 0) return []
  const out: { name: string; url: string }[] = []
  for (const obj of matching) {
    if (!obj.Key) continue
    out.push({
      name: obj.Key.split('/').pop() ?? '',
      url: await getSignedDownloadUrl(obj.Key),
    })
  }
  return out
}

export const deleteObjectsByKeys = async (keys: string[]) => {
  const { client, bucket } = getS3()
  let deleted = 0
  for (const key of keys) {
    if (!key) continue
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      deleted++
    } catch (err) {
      logger.error({ err: (err as Error).message, key }, 's3_delete_failed')
    }
  }
  return { requested: keys.length, deleted }
}
