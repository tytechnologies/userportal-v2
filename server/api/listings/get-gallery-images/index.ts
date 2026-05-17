import { listObjectsByPrefix, getSignedDownloadUrl } from '~~/server/utils/s3'
import { assertCanReadListing } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const body = await readBody(event).catch(() => ({} as any))
    // assertCanReadListing coerces to int + RLS-checks; throws 400/404
    // on bad input or hidden row. Returns a sanitized numeric id safe
    // to interpolate into the S3 prefix.
    const id = await assertCanReadListing(event, body?.listingId)

    const objects = await listObjectsByPrefix(`properties/property-${id}/`)
    const data = await Promise.all(
      objects
        .filter((obj) => obj.Key && obj.Key.includes('635x423'))
        .map((obj) => getSignedDownloadUrl(obj.Key!)),
    )
    return { success: true, data }
  },
})
