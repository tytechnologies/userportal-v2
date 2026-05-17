import { listObjectsByPrefix, getSignedDownloadUrl } from '~~/server/utils/s3'
import { assertCanReadListing } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    let rawId: unknown
    if (getMethod(event) === 'POST') {
      const body = await readBody(event).catch(() => ({} as any))
      rawId = body?.listingId
    } else {
      const q = getQuery(event)
      const raw = q?.listingId
      rawId = Array.isArray(raw) ? raw[0] : raw
    }

    const id = await assertCanReadListing(event, rawId)
    const objects = await listObjectsByPrefix(`properties/property-${id}/`)
    const data = await Promise.all(
      objects.filter((o) => o.Key).map((o) => getSignedDownloadUrl(o.Key!)),
    )
    return { success: true, data }
  },
})
