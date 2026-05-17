class ThumbnailCache {
  constructor() {
    this.cache = new Map()
    this.maxCacheSize = 50 // Maximum number of cached thumbnails
    this.stats = {
      hits: 0,
      misses: 0,
      fetches: 0,
    }
  }

  // Generate a cache key for a listing
  getCacheKey(listingId) {
    return `thumbnail_${listingId}`
  }

  // Check if thumbnail is cached
  isCached(listingId) {
    return this.cache.has(this.getCacheKey(listingId))
  }

  // Get cached thumbnail
  getCachedThumbnail(listingId) {
    const cacheKey = this.getCacheKey(listingId)
    const cached = this.cache.get(cacheKey)

    if (cached && cached.timestamp) {
      // Check if cache is still valid (7 days)
      const now = Date.now()
      const cacheAge = now - cached.timestamp
      const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds

      if (cacheAge < maxAge) {
        this.stats.hits++
        return cached.url
      } else {
        // Cache expired, remove it
        this.cache.delete(cacheKey)
        this.stats.misses++
      }
    }

    this.stats.misses++
    return null
  }

  // Cache a thumbnail
  cacheThumbnail(listingId, url) {
    const cacheKey = this.getCacheKey(listingId)

    // Remove oldest entries if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value
      this.cache.delete(oldestKey)
    }

    this.cache.set(cacheKey, {
      url: url,
      timestamp: Date.now(),
    })

    this.stats.fetches++
    console.log(`Cached thumbnail for listing ${listingId}`)
  }

  // Clear cache for a specific listing
  clearCache(listingId) {
    const cacheKey = this.getCacheKey(listingId)
    this.cache.delete(cacheKey)
  }

  // Clear all cache
  clearAllCache() {
    this.cache.clear()
    this.stats = { hits: 0, misses: 0, fetches: 0 }
  }

  // Get cache statistics
  getCacheStats() {
    const hitRate =
      this.stats.hits + this.stats.misses > 0
        ? (
            (this.stats.hits / (this.stats.hits + this.stats.misses)) *
            100
          ).toFixed(1)
        : 0

    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      keys: Array.from(this.cache.keys()),
      stats: {
        hits: this.stats.hits,
        misses: this.stats.misses,
        fetches: this.stats.fetches,
        hitRate: `${hitRate}%`,
      },
    }
  }

  // Get cache performance info
  getPerformanceInfo() {
    const stats = this.getCacheStats()
    return {
      cacheSize: `${stats.size}/${stats.maxSize}`,
      hitRate: stats.stats.hitRate,
      totalRequests: stats.stats.hits + stats.stats.misses,
      totalFetches: stats.stats.fetches,
    }
  }
}

// Create a singleton instance
const thumbnailCache = new ThumbnailCache()

export default thumbnailCache
