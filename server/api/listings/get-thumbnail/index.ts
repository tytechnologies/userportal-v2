import { getListingThumbnailUrl } from '~~/server/utils/s3'
import { assertCanReadListing } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const body = await readBody(event).catch(() => ({} as any))
    const id = await assertCanReadListing(event, body?.listingId)
    return { success: true, data: await getListingThumbnailUrl(id) }
  },
})
