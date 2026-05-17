const getSignedUrlForPath = async (id) => {
  try {
    const response = await $fetch('/api/listings/get-gallery-images', {
      method: 'POST',
      body: { listingId: id }
    })

    if (!response.success) {
      throw new Error(response.message || 'Failed to get gallery images')
    }

    return response.data
  } catch (error) {
    console.error('Error getting gallery images:', error)
    throw error
  }
}

export const getGalleryImages = async (listingId) => {
  // get image from local storage
  const images = await getSignedUrlForPath(listingId)
  console.log('images: ', images)

  return { success: true, data: images }
}
