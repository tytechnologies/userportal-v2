export const getContactAvatar = async (contact_id) => {
  try {
    const response = await $fetch('/api/contacts/get-contact-image', {
      method: 'POST',
      body: { user_id: contact_id }
    })

    if (response.success && response.data) {
      return response.data
    }
    
    return []
  } catch (error) {
    console.error('Error getting contact avatar:', error)
    return []
  }
}
