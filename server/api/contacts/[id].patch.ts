import { contactsRepo } from '~~/server/repositories/contacts.repo'
import { contactUpdateSchema } from '~~/schemas/contact'
import { uploadContactAvatar } from '~~/server/utils/s3'

export default defineApiHandler({
  body: contactUpdateSchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid contact id' })
    }

    const updated = await contactsRepo.update({ event, id, input: body })

    if (body.avatarImage) {
      try {
        const avatarUrl = await uploadContactAvatar(id, body.avatarImage)
        return await contactsRepo.updateAvatarUrl({ event, id, avatarUrl })
      } catch (err) {
        return updated
      }
    }

    return updated
  },
})
