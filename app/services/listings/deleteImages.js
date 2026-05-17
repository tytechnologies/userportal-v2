export const deleteImages = async (listingId) => {
  if (!listingId) {
    throw new Error('Listing ID is required')
  }

  try {
    const result = await $fetch(`/api/listings/${listingId}/images`, {
      method: 'DELETE',
    })
    return {
      success: true,
      message: `Successfully deleted ${result.total} images`,
      deletedCount: result.total,
    }
  } catch (error) {
    console.error('Error deleting images:', error)
    return {
      success: false,
      message: error?.data?.statusMessage || error?.message || 'Error deleting images',
    }
  }
}
