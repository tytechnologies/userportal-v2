export default class OriginalImagesController {
  listing_id = 0

  constructor(listing_id) {
    this.listing_id = listing_id
  }

  async uploadOriginalImages(imagesData) {
    if (!imagesData || imagesData.length === 0) return []
    if (!this.listing_id) {
      throw new Error('Listing ID is required for image upload')
    }

    const response = await $fetch('/api/listings/upload-original-images', {
      method: 'POST',
      body: { listingId: this.listing_id, images: imagesData },
    })

    if (!response?.success || !response.uploadedUrls) {
      throw new Error('Upload failed: invalid response from server')
    }
    return response.uploadedUrls
  }

  async getOriginalImages(listing_id) {
    return $fetch(`/api/listings/${listing_id}/images/original`)
  }

  async deleteOriginalImages(keys) {
    return $fetch(`/api/listings/${this.listing_id}/images/delete-by-keys`, {
      method: 'POST',
      body: { keys },
    })
  }

  async cloneOriginalImages(sourceListingId, targetListingId) {
    const result = await $fetch(`/api/listings/${sourceListingId}/images/clone`, {
      method: 'POST',
      body: { targetListingId },
    })
    return result.original
  }

  async updateThumbnailSelection(listingId, newThumbnailImageId) {
    const result = await $fetch('/api/listings/update-thumbnail', {
      method: 'POST',
      body: { listingId, newThumbnailImageId },
    })
    return result.original
  }

  async updateOriginalImages() {
    throw new Error(
      'updateOriginalImages is not supported — split into uploadOriginalImages + deleteOriginalImages',
    )
  }
}
