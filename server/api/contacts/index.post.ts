import { contactsRepo } from '~~/server/repositories/contacts.repo'
import { contactCreateSchema } from '~~/schemas/contact'
import { uploadContactAvatar } from '~~/server/utils/s3'

export default defineApiHandler({
  body: contactCreateSchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const contact = await contactsRepo.create({ event, input: body })

    if (body.avatarImage) {
      try {
        const avatarUrl = await uploadContactAvatar(contact.id, body.avatarImage)
        const updated = await contactsRepo.updateAvatarUrl({ event, id: contact.id, avatarUrl })
        return updated
      } catch (err) {
        // Avatar upload is non-fatal; contact was created.
        return contact
      }
    }

    return contact
  },
})
