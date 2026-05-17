export default class dbImagesEngine {
  listing_id = 0
  supabase = useSupabaseClient()

  constructor(listing_id) {
    this.listing_id = listing_id
  }

  async uploadImageToDB(imagesData) {
    //upload image to db
    console.log('this.listing_id: ', this.listing_id)

    // Get the highest existing media_id so the new rows extend the
    // sequence without colliding. `.single()` was the previous call,
    // but it errors PGRST116 when the table is empty (greenfield envs)
    // — the next line then dereferences `highestMediaId.media_id` on
    // null and throws. `.maybeSingle()` returns `null` cleanly; we
    // default to 0 so the first inserted row gets media_id=1.
    const { data: highestMediaId, error: highestMediaIdError } =
      await this.supabase
        .from('listing_images')
        .select('media_id')
        .order('media_id', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (highestMediaIdError) {
      console.error(
        'uploadImageToDB: failed to read max media_id',
        highestMediaIdError,
      )
      return null
    }

    let lastKnownMediaId = highestMediaId?.media_id ?? 0

    for (const [index, image] of imagesData.entries()) {
      lastKnownMediaId++
      // Normalize extension to match what server's decodeDataUrl
      // sniffs from the MIME type — that's the canonical form S3
      // writes (.jpeg, not .jpg; .png; .webp). Clients sometimes pass
      // image.extension='jpg' or with capitals; if we don't normalize,
      // DB file_name says .jpg while S3 says .jpeg and the
      // get-gallery-images endpoint can't join them.
      const rawExt = String(image?.extension ?? '').toLowerCase().replace(/^\.+/, '')
      const ext = rawExt === 'jpg' ? 'jpeg' : (rawExt || 'jpeg')
      const { data, error } = await this.supabase
        .from('listing_images')
        .insert({
          listing_id: this.listing_id,
          file_name:
            index === 0
              ? `property-${this.listing_id}/thumbnail-image-${index}-635x423.${ext}`
              : `property-${this.listing_id}/image-${index}-635x423.${ext}`,
          extension: ext,
          media_id: lastKnownMediaId,
          no_watermark_filename:
            index === 0
              ? `property-${this.listing_id}/thumbnail-image-${index}-635x423.${ext}`
              : `property-${this.listing_id}/image-${index}-635x423.${ext}`,
        })
        .select()

      if (error) {
        console.error(error)
        return null
      }

      console.info('uploaded images to db: ', data)
    }
  }
  async getImageFromDB() {
    //get image original path from db
    console.log('this.listing_id: ', this.listing_id)
    const { data, error } = await this.supabase
      .from('listing_images')
      .select('file_name, extension')
      .eq('listing_id', this.listing_id)

    if (error) {
      console.error(error)
      return null
    }

    const originalPaths = []
    for (const image of data) {
      originalPaths.push(
        `properties/original/property-${this.listing_id}/${image.file_name}.${image.extension}`
      )
    }

    console.log('originalPaths: ', originalPaths)

    return originalPaths
  }
  async deleteImageFromDB() {
    //delete image from db
    console.log('this.listing_id: ', this.listing_id)
    const { data, error } = await this.supabase
      .from('listing_images')
      .delete()
      .eq('listing_id', this.listing_id)

    if (error) {
      console.error(error)
    }

    return data
  }
  async updateImageInDB() {
    //update image in db
    console.log('this.listing_id: ', this.listing_id)
    console.log('this.imagesData: ', this.imagesData)
    const { data, error } = await this.supabase
      .from('listing_images')
      .update({
        file_name: this.imagesData.file_name,
        extension: this.imagesData.extension,
      })
      .eq('listing_id', this.listing_id)

    if (error) {
      console.error(error)
    }

    return data
  }

  async updateThumbnailSelection(
    listingId,
    newThumbnailImageId,
    displayedResults,
    originalResults
  ) {
    console.log(
      `Updating database thumbnail for listing ${listingId} to image ${newThumbnailImageId}`
    )

    try {
      // Get all images for this listing
      const { data: images, error: fetchError } = await this.supabase
        .from('listing_images')
        .select('*')
        .eq('listing_id', listingId)

      if (fetchError) {
        throw new Error(`Failed to fetch images: ${fetchError.message}`)
      }

      console.log(
        `Found ${images.length} database images for listing ${listingId}`
      )

      const results = {
        updated: [],
        errors: [],
        success: false,
      }

      // Update the current thumbnail to remove thumbnail prefix
      if (displayedResults.currentThumbnail) {
        const currentThumbnailImage = images.find((img) =>
          img.file_name.includes(displayedResults.currentThumbnail.oldFileName)
        )

        if (currentThumbnailImage) {
          const newFileName = displayedResults.currentThumbnail.newFileName
          const newNoWatermarkFileName =
            originalResults.currentThumbnail?.newFileName || newFileName

          const { data: updateData, error: updateError } = await this.supabase
            .from('listing_images')
            .update({
              file_name: newFileName,
              no_watermark_filename: newNoWatermarkFileName,
            })
            .eq('id', currentThumbnailImage.id)
            .select()

          if (updateError) {
            console.error(
              `Failed to update current thumbnail: ${updateError.message}`
            )
            results.errors.push({
              imageId: currentThumbnailImage.id,
              error: updateError.message,
            })
          } else {
            console.log(
              `Updated current thumbnail in DB: ${currentThumbnailImage.id}`
            )
            results.updated.push({
              imageId: currentThumbnailImage.id,
              oldFileName: currentThumbnailImage.file_name,
              newFileName: newFileName,
            })
          }
        }
      }

      // Update the new thumbnail to add thumbnail prefix
      if (displayedResults.newThumbnail) {
        const newThumbnailImage = images.find((img) =>
          img.file_name.includes(displayedResults.newThumbnail.oldFileName)
        )

        if (newThumbnailImage) {
          const newFileName = displayedResults.newThumbnail.newFileName
          const newNoWatermarkFileName =
            originalResults.newThumbnail?.newFileName || newFileName

          const { data: updateData, error: updateError } = await this.supabase
            .from('listing_images')
            .update({
              file_name: newFileName,
              no_watermark_filename: newNoWatermarkFileName,
            })
            .eq('id', newThumbnailImage.id)
            .select()

          if (updateError) {
            console.error(
              `Failed to update new thumbnail: ${updateError.message}`
            )
            results.errors.push({
              imageId: newThumbnailImage.id,
              error: updateError.message,
            })
          } else {
            console.log(`Updated new thumbnail in DB: ${newThumbnailImage.id}`)
            results.updated.push({
              imageId: newThumbnailImage.id,
              oldFileName: newThumbnailImage.file_name,
              newFileName: newFileName,
            })
          }
        }
      }

      results.success = results.errors.length === 0
      console.log('Database thumbnail update completed')

      return results
    } catch (error) {
      console.error('Error updating database thumbnail selection:', error)
      throw error
    }
  }

  async checkCurrentUsedProperties() {
    console.log('this.listing_id: ', this.listing_id)
    console.log('this.imagesData: ', this.imagesData)
  }
}
