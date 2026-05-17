const getSignedUrlForPath = async (id) => {
  try {
    const response = await $fetch('/api/listings/get-thumbnail', {
      method: 'POST',
      body: { listingId: id }
    })

    if (!response.success) {
      throw new Error(response.message || 'Failed to get thumbnail')
    }

    return response.data
  } catch (error) {
    console.error('Error getting thumbnail:', error)
    throw error
  }
}

export const getImageThumbnail = async (listingId) => {
  // get image from local storage
  const image = await getSignedUrlForPath(listingId)
  console.log('image: ', image)

  return { success: true, data: image }
}
