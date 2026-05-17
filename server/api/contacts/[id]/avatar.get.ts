import { getContactAvatarUrls } from '~~/server/utils/s3'
import { assertCanReadContact } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = await assertCanReadContact(event, getRouterParam(event, 'id'))
    const urls = await getContactAvatarUrls(id)
    return { url: urls[0] ?? '' }
  },
})
