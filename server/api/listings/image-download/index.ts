import { listObjectsByPrefix, getSignedDownloadUrl } from '~~/server/utils/s3'
import { assertCanReadListing } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const body = await readBody(event).catch(() => ({} as any))
    const id = await assertCanReadListing(event, body?.listingId)
    const withWatermark = body?.withWatermark !== undefined ? body.withWatermark : true

    const prefix = withWatermark
      ? `properties/property-${id}/`
      : `properties/original/property-${id}/`

    const objects = await listObjectsByPrefix(prefix)
    const data = await Promise.all(
      objects
        .filter((o) => o.Key)
        .map(async (object) => ({
          signedUrl: await getSignedDownloadUrl(object.Key!),
          object,
        })),
    )
    return { success: true, data }
  },
})
