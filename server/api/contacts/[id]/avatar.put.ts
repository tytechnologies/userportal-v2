import { contactsRepo } from '~~/server/repositories/contacts.repo'
import { contactAvatarSchema } from '~~/schemas/contact'
import { uploadContactAvatar } from '~~/server/utils/s3'

export default defineApiHandler({
  body: contactAvatarSchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid contact id' })
    }

    const avatarUrl = await uploadContactAvatar(id, body.avatarImage)
    return contactsRepo.updateAvatarUrl({ event, id, avatarUrl })
  },
})
