import thumbnailCache from '~/services/images/thumbnailCache'
import DisplayedImagesController from '~/services/images/displayedImagesController'

export const useThumbnailCache = () => {
  // Get cache statistics
  const getCacheStats = () => {
    return thumbnailCache.getCacheStats()
  }

  // Clear all cache
  const clearAllCache = () => {
    thumbnailCache.clearAllCache()
    console.log('All thumbnail cache cleared')
  }

  // Clear cache for specific listing
  const clearListingCache = (listingId: number) => {
    thumbnailCache.clearCache(listingId)
    console.log(`Cache cleared for listing ${listingId}`)
  }

  // Preload thumbnails for multiple listings
  const preloadThumbnails = async (listings: any[]) => {
    console.log(`Preloading thumbnails for ${listings.length} listings`)
    
    const promises = listings.map(async (listing) => {
      if (listing.listing_id) {
        try {
          const cachedUrl = thumbnailCache.getCachedThumbnail(listing.listing_id)
          if (!cachedUrl) {
            // Only fetch if not already cached
            const imagesController = new DisplayedImagesController(listing.listing_id)
            const url = await imagesController.getDisplayedImagesThumbnail(listing.listing_id)
            
            if (url && url !== '/img/hi_logo.svg') {
              thumbnailCache.cacheThumbnail(listing.listing_id, url)
            }
          }
        } catch (error) {
          console.error(`Failed to preload thumbnail for listing ${listing.listing_id}:`, error)
        }
      }
    })

    await Promise.allSettled(promises)
    console.log('Thumbnail preloading completed')
  }

  return {
    getCacheStats,
    clearAllCache,
    clearListingCache,
    preloadThumbnails
  }
} 