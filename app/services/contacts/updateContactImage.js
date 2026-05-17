export const updateContactAvatar = async (contact_id, avatarImage) => {
  if (!contact_id || !avatarImage) {
    throw new Error('Missing required parameters: contact_id or avatarImage')
  }
  if (!avatarImage.startsWith('data:image/')) {
    throw new Error('Invalid image format. Expected data URL format.')
  }

  await $fetch(`/api/contacts/${contact_id}/avatar`, {
    method: 'PUT',
    body: { avatarImage },
  })

  return true
}
