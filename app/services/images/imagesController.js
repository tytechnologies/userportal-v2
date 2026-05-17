import DisplayedImagesController from './displayedImagesController'
import OriginalImagesController from './originalImagesController'
import dbImagesEngine from './dbImagesEngine'

export default class ImagesController {
  constructor(listing_id) {
    this.listing_id = listing_id
    this.displayedImagesController = null
    this.originalImagesController = null
    this.dbImagesEngine = null
  }

  // Static factory method for async initialization
  static async create(listing_id) {
    const instance = new ImagesController(listing_id)
    await instance.initialize()
    return instance
  }

  // Async initialization method
  async initialize() {
    try {
      this.displayedImagesController = new DisplayedImagesController(
        this.listing_id
      )
      // Ensure credentials are loaded
      await this.displayedImagesController.initialize()
    } catch (error) {
      console.error('Error initializing displayed images controller: ', error)
    }

    try {
      this.originalImagesController = new OriginalImagesController(
        this.listing_id
      )
      // Note: OriginalImagesController doesn't have initialize(), credentials are set in constructor
    } catch (error) {
      console.error('Error initializing original images controller: ', error)
    }

    try {
      this.dbImagesEngine = new dbImagesEngine(this.listing_id)
    } catch (error) {
      console.error('Error initializing db images engine: ', error)
    }
  }

  //function to upload displayed, original, and db images
  async uploadImages(watermarkedImages, originalImages) {
    // handle displayed images
    if (!this.displayedImagesController) {
      console.error('Displayed images controller not initialized')
      return
    }
    if (!this.originalImagesController) {
      console.error('Original images controller not initialized')
      return
    }
    if (!this.dbImagesEngine) {
      console.error('Db images engine not initialized')
      return
    }
    try {
      await this.displayedImagesController.uploadDisplayedImages(
        watermarkedImages
      )
    } catch (error) {
      console.error('Error uploading displayed images: ', error)
    }

    // handle original images
    try {
      await this.originalImagesController.uploadOriginalImages(originalImages)
    } catch (error) {
      console.error('Error uploading original images: ', error)
    }
    try {
      await this.dbImagesEngine.uploadImageToDB(originalImages)
    } catch (error) {
      console.error('Error uploading images to db: ', error)
    }
  }

  async deleteImages() {
    const results = {
      displayed: null,
      original: null,
      database: null,
      success: false,
    }

    try {
      // Extract the S3 keys from the imagesData objects
      const displayedKeys = this.imagesData.map(
        (image) => image.displayedKey || image.key
      )
      const originalKeys = this.imagesData.map(
        (image) => image.originalKey || image.key
      )

      // Delete displayed images from S3
      if (this.displayedImagesController) {
        results.displayed =
          await this.displayedImagesController.deleteDisplayedImages(
            displayedKeys
          )
        console.log('Displayed images deleted:', results.displayed)
      }

      // Delete original images from S3
      if (this.originalImagesController) {
        results.original =
          await this.originalImagesController.deleteOriginalImages(originalKeys)
        console.log('Original images deleted:', results.original)
      }

      // Delete database entries
      if (this.dbImagesEngine) {
        results.database = await this.dbImagesEngine.deleteImageFromDB(
          this.imagesData
        )
        console.log('Database entries deleted:', results.database)
      }

      results.success = true
      console.log('Image deletion completed successfully')
    } catch (error) {
      console.error('Error deleting images:', error)
      results.error = error.message
    }

    return results
  }

  async updateImages() {
    const updatedDisplayedImages =
      await this.displayedImagesController.updateDisplayedImages(
        this.imagesData
      )
    const updatedOriginalImages =
      await this.originalImagesController.updateOriginalImages(this.imagesData)
    const updatedDbImages = await this.dbImagesEngine.updateImageInDB(
      this.imagesData
    )
  }

  async getDisplayedImages(listing_id) {
    const displayedImages =
      await this.displayedImagesController.getDisplayedImages(listing_id)
    return displayedImages
  }

  async getOriginalImages(listing_id) {
    const originalImages =
      await this.originalImagesController.getOriginalImages(listing_id)
    return originalImages
  }

  async cloneImages(sourceListingId, targetListingId) {
    const results = {
      displayed: null,
      original: null,
      database: null,
      success: false,
    }

    try {
      // Clone both displayed + original prefixes via a single server call.
      const cloned = await $fetch(`/api/listings/${sourceListingId}/images/clone`, {
        method: 'POST',
        body: { targetListingId },
      })
      results.displayed = cloned.displayed
      results.original = cloned.original

      if (this.dbImagesEngine) {
        results.database = await this.cloneDatabaseEntries(
          sourceListingId,
          targetListingId,
        )
      }

      results.success = true
    } catch (error) {
      console.error('Error cloning images:', error)
      results.error = error.message
    }

    return results
  }

  async cloneDatabaseEntries(sourceListingId, targetListingId) {
    try {
      // Get source listing images from database
      const { data: sourceImages, error: sourceError } =
        await this.dbImagesEngine.supabase
          .from('listing_images')
          .select('*')
          .eq('listing_id', sourceListingId)

      if (sourceError) {
        throw new Error(`Failed to fetch source images: ${sourceError.message}`)
      }

      if (!sourceImages || sourceImages.length === 0) {
        return {
          total: 0,
          successful: 0,
          failed: 0,
          message: 'No source images found',
        }
      }

      // Clone each image entry for the target listing
      const clonePromises = sourceImages.map(async (sourceImage) => {
        try {
          // Update the file_name to use the target listing ID
          const newFileName = sourceImage.file_name.replace(
            `property-${sourceListingId}`,
            `property-${targetListingId}`
          )

          const newNoWatermarkFilename =
            sourceImage.no_watermark_filename.replace(
              `property-${sourceListingId}`,
              `property-${targetListingId}`
            )

          const { data, error } = await this.dbImagesEngine.supabase
            .from('listing_images')
            .insert({
              listing_id: targetListingId,
              file_name: newFileName,
              extension: sourceImage.extension,
              media_id: sourceImage.media_id, // You might want to generate a new media_id
              no_watermark_filename: newNoWatermarkFilename,
            })
            .select()

          if (error) {
            console.error(
              `Failed to clone database entry for ${sourceImage.file_name}:`,
              error
            )
            return { sourceImage, success: false, error: error.message }
          }

          console.log(
            `Cloned database entry: ${sourceImage.file_name} -> ${newFileName}`
          )
          return { sourceImage, newImage: data[0], success: true }
        } catch (error) {
          console.error(
            `Error cloning database entry for ${sourceImage.file_name}:`,
            error
          )
          return { sourceImage, success: false, error: error.message }
        }
      })

      const results = await Promise.all(clonePromises)
      const successful = results.filter((result) => result.success)
      const failed = results.filter((result) => !result.success)

      return {
        total: sourceImages.length,
        successful: successful.length,
        failed: failed.length,
        results,
      }
    } catch (error) {
      console.error('Error cloning database entries:', error)
      return { total: 0, successful: 0, failed: 0, error: error.message }
    }
  }

  async updateThumbnailSelection(listingId, newThumbnailImageId) {
    console.log(
      `Updating thumbnail selection for listing ${listingId} to image ${newThumbnailImageId}`
    )

    const results = {
      displayed: null,
      original: null,
      database: null,
      success: false,
    }

    try {
      // Update displayed images in S3
      if (this.displayedImagesController) {
        results.displayed =
          await this.displayedImagesController.updateThumbnailSelection(
            listingId,
            newThumbnailImageId
          )
        console.log('Displayed images thumbnail updated:', results.displayed)
      }

      // Update original images in S3
      if (this.originalImagesController) {
        results.original =
          await this.originalImagesController.updateThumbnailSelection(
            listingId,
            newThumbnailImageId
          )
        console.log('Original images thumbnail updated:', results.original)
      }

      // Update database entries
      if (this.dbImagesEngine) {
        results.database = await this.dbImagesEngine.updateThumbnailSelection(
          listingId,
          newThumbnailImageId,
          results.displayed,
          results.original
        )
        console.log('Database thumbnail updated:', results.database)
      }

      results.success = true
      console.log('Thumbnail selection update completed successfully')
    } catch (error) {
      console.error('Error updating thumbnail selection:', error)
      results.error = error.message
    }

    return results
  }
}
