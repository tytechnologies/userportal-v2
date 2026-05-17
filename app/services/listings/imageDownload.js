const getImagesFromS3 = async (listingId) => {
  try {
    const response = await $fetch('/api/listings/get-images', {
      method: 'POST',
      body: { listingId }
    })

    if (!response.success) {
      throw new Error(response.message || 'Failed to get images')
    }

    return response.data
  } catch (error) {
    console.error('Error getting images from S3:', error)
    throw error
  }
}

export const fetchImageUrls = async (listingId) => {
  try {
    if (!listingId) {
      throw new Error('Listing ID is required')
    }

    const imageUrls = await getImagesFromS3(listingId)

    console.log('imageUrls count: ', imageUrls.length)

    return { success: true, data: imageUrls }
  } catch (error) {
    console.error('Error getting image URLs:', error)
    return {
      success: false,
      message: error.message || 'Error getting image URLs',
    }
  }
}
