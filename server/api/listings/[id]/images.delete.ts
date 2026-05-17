import { deleteListingImages } from '~~/server/utils/s3'
import { assertCanWriteListing } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = await assertCanWriteListing(event, getRouterParam(event, 'id'))
    return deleteListingImages(id)
  },
})
