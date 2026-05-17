import { getListingThumbnailUrl } from '~~/server/utils/s3'
import { assertCanReadListing } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = await assertCanReadListing(event, getRouterParam(event, 'id'))
    return { signedUrl: await getListingThumbnailUrl(id) }
  },
})
