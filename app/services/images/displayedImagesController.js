export default class DisplayedImagesController {
  listing_id = 0
  imagesData = []

  constructor(listing_id) {
    this.listing_id = listing_id
  }

  // Kept for back-compat with imagesController.create(); does nothing now
  // that credentials live server-side and clients only $fetch.
  async initialize() {}

  async uploadDisplayedImages(imagesData) {
    if (!imagesData || imagesData.length === 0) return []
    if (!this.listing_id) {
      throw new Error('Listing ID is required for image upload')
    }

    const response = await $fetch('/api/listings/upload-displayed-images', {
      method: 'POST',
      body: { listingId: this.listing_id, images: imagesData },
    })

    if (!response?.success || !response.uploadedUrls) {
      throw new Error('Upload failed: invalid response from server')
    }
    return response.uploadedUrls
  }

  async getDisplayedImages(listing_id) {
    return $fetch(`/api/listings/${listing_id}/images/displayed`)
  }

  async deleteDisplayedImages(keys) {
    return $fetch(`/api/listings/${this.listing_id}/images/delete-by-keys`, {
      method: 'POST',
      body: { keys },
    })
  }

  async cloneDisplayedImages(sourceListingId, targetListingId) {
    const result = await $fetch(`/api/listings/${sourceListingId}/images/clone`, {
      method: 'POST',
      body: { targetListingId },
    })
    return result.displayed
  }

  async updateThumbnailSelection(listingId, newThumbnailImageId) {
    const result = await $fetch('/api/listings/update-thumbnail', {
      method: 'POST',
      body: { listingId, newThumbnailImageId },
    })
    return result.displayed
  }

  async getDisplayedImagesThumbnail(listingId) {
    const { signedUrl } = await $fetch(`/api/listings/${listingId}/thumbnail`)
    return signedUrl ?? '/img/hi_logo.svg'
  }

  // Update via mixed add/delete payloads with raw buffers was an abandoned
  // path on the client. Surface it loudly if anything still calls this.
  async updateDisplayedImages() {
    throw new Error(
      'updateDisplayedImages is not supported — split into uploadDisplayedImages + deleteDisplayedImages',
    )
  }
}
