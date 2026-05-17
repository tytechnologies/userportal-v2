import { defineStore } from 'pinia'
import thumbnailCache from '~/services/images/thumbnailCache'
import { getImageThumbnail } from '~/services/listings/getImageThumbnail'

export const useThumbnailStore = defineStore('thumbnails', {
  state: () => ({
    thumbnailUrls: new Map<string, string>(),
    loadingStates: new Map<string, boolean>(),
    errorStates: new Map<string, string>(),
  }),

  getters: {
    getThumbnailUrl: (state) => (listingId: number) => {
      return state.thumbnailUrls.get(listingId.toString()) || null
    },
    
    isLoading: (state) => (listingId: number) => {
      return state.loadingStates.get(listingId.toString()) || false
    },
    
    hasError: (state) => (listingId: number) => {
      return state.errorStates.has(listingId.toString())
    },
    
    getError: (state) => (listingId: number) => {
      return state.errorStates.get(listingId.toString()) || null
    },
    
    getCacheStats: () => {
      return thumbnailCache.getCacheStats()
    }
  },

  actions: {
    async fetchThumbnail(listingId: number) {
      const listingIdStr = listingId.toString()
      
      // Check if already loaded
      if (this.thumbnailUrls.has(listingIdStr)) {
        return this.thumbnailUrls.get(listingIdStr)
      }
      
      // Check if already loading
      if (this.loadingStates.get(listingIdStr)) {
        return null
      }
      
      // Check cache first
      const cachedUrl = thumbnailCache.getCachedThumbnail(listingId)
      if (cachedUrl) {
        this.thumbnailUrls.set(listingIdStr, cachedUrl)
        return cachedUrl
      }
      
      // Set loading state
      this.loadingStates.set(listingIdStr, true)
      this.errorStates.delete(listingIdStr)
      
      try {
        const response = await getImageThumbnail(listingId)
        
        if (response.success && response.data && response.data !== '/img/hi_logo.svg') {
          // Cache the thumbnail
          thumbnailCache.cacheThumbnail(listingId, response.data)
          this.thumbnailUrls.set(listingIdStr, response.data)
          this.loadingStates.delete(listingIdStr)
          return response.data
        } else {
          throw new Error('No valid thumbnail found')
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        this.errorStates.set(listingIdStr, errorMessage)
        this.loadingStates.delete(listingIdStr)
        console.error(`Failed to fetch thumbnail for listing ${listingId}:`, error)
        return null
      }
    },
    
    async preloadThumbnails(listings: any[]) {
      console.log(`Preloading ${listings.length} thumbnails...`)
      
      const promises = listings.map(async (listing) => {
        if (listing.listing_id) {
          await this.fetchThumbnail(listing.listing_id)
        }
      })
      
      await Promise.allSettled(promises)
      console.log('Thumbnail preloading completed')
    },
    
    setThumbnailUrl(listingId: number, url: string) {
      this.thumbnailUrls.set(listingId.toString(), url)
    },
    
    clearThumbnail(listingId: number) {
      const listingIdStr = listingId.toString()
      this.thumbnailUrls.delete(listingIdStr)
      this.loadingStates.delete(listingIdStr)
      this.errorStates.delete(listingIdStr)
    },
    
    clearAllThumbnails() {
      this.thumbnailUrls.clear()
      this.loadingStates.clear()
      this.errorStates.clear()
    }
  }
}) 