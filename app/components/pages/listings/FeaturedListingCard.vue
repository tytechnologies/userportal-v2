<template>
  <div
    class="relative h-full w-full overflow-hidden rounded-lg shadow-lg"
    v-if="property && property.listing_id"
  >
    <img
      :src="thumbnailUrl"
      alt="property image"
      class="object-cover w-full h-full"
    />
    <div class="absolute bottom-0 w-full pt-1 text-sm bg-foreground/50">
      <p class="w-full px-2 text-sm text-white" :alt="property.title">
        {{
          property.title && property.title.length > 25
            ? property.title.substr(0, 31) + '...'
            : property.title
        }}
      </p>
      <div class="flex items-center justify-between w-full px-2 text-white">
        <p v-if="property.sale_price">
          ₱
          <span class="text-sm font-bold lg:text-xl">{{
            formatCurrency(property.sale_price)
          }}</span>
        </p>
        <p v-if="property.rent_price">
          ₱
          <span class="text-sm font-bold lg:text-xl">{{
            formatCurrency(property.rent_price)
          }}</span>
          / month
        </p>
        <div class="absolute bottom-[10px] right-[10px] z-10">
          <h6 class="flex h-[17px] gap-2 my-4 text-white">
            <font-awesome-icon
              icon="location-dot"
              style="height: 17px; color: #2f80ed"
            />
            {{
              property.street_address && property.street_address.length > 12
                ? property.street_address.substr(0, 12) + '...'
                : property.street_address
            }}
          </h6>
          <h6
            class="flex h-[17px] gap-2 my-4 lg:my-0 text-white"
            v-if="property.building_name"
          >
            <font-awesome-icon
              icon="building"
              style="height: 17px; color: #2f80ed"
            />
            {{ property.building_name }}
          </h6>
        </div>
        <ul class="flex items-center justify-between gap-2">
          <li v-if="property.bedrooms && property.bedrooms > 0">
            <span class="text-sm font-bold lg:text-xl">{{
              property.bedrooms
            }}</span>
            br
          </li>
          <li
            v-if="
              property.bedrooms &&
              property.bedrooms > 0 &&
              property.floor_area &&
              property.floor_area > 0.0
            "
            class="md:hidden"
          >
            <span class="block w-1 h-1 bg-muted rounded-full">&nbsp;</span>
          </li>
          <li v-if="property.floor_area == 0.0">
            <span class="text-sm font-bold lg:text-xl">{{
              property.lot_area || 0
            }}</span>
            sqm
          </li>
          <li v-else>
            <span class="text-sm font-bold lg:text-xl">{{
              property.floor_area || 0
            }}</span>
            sqm
          </li>
        </ul>
      </div>
    </div>
  </div>
  <div
    v-else
    class="flex items-center justify-center h-full w-full bg-muted rounded-lg"
  >
    <span class="text-muted-foreground">Select a property</span>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import DisplayedImagesController from '~/services/images/displayedImagesController'
import thumbnailCache from '~/services/images/thumbnailCache'
import { useThumbnailStore } from '~/store/thumbnailStore'
import { formatCurrency } from '~/helpers/helpers'

const props = defineProps({
  property: {
    type: Object,
    default: null,
  },
  preloadedThumbnail: {
    type: String,
    default: null,
  },
})

const thumbnailStore = useThumbnailStore()
const thumbnailUrl = ref('/img/placeholder_listing_img.png')
const isLoading = ref(false)

const formattedPrice = computed(() => {
  if (!props.property) return ''
  const price = props.property.rent_price || props.property.sale_price
  if (!price) return ''
  return formatCurrency(price)
})

// Computed property to get thumbnail URL from store
const storeThumbnailUrl = computed(() => {
  if (!props.property?.listing_id) return null
  return thumbnailStore.getThumbnailUrl(props.property.listing_id)
})

// Computed property to check loading state
const storeLoadingState = computed(() => {
  if (!props.property?.listing_id) return false
  return thumbnailStore.isLoading(props.property.listing_id)
})

async function fetchThumbnail() {
  if (!props.property || !props.property.listing_id) {
    thumbnailUrl.value = '/img/placeholder_listing_img.png'
    return
  }

  const listingId = props.property.listing_id

  // Use preloaded thumbnail if available (highest priority)
  if (props.preloadedThumbnail) {
    console.log(`Using preloaded thumbnail for listing ${listingId}`)
    thumbnailUrl.value = props.preloadedThumbnail
    // Also store it in the store for future use
    thumbnailStore.setThumbnailUrl(listingId, props.preloadedThumbnail)
    return
  }

  // Check store first (persists across component unmounts)
  const storeUrl = storeThumbnailUrl.value
  if (storeUrl) {
    console.log(`Using store thumbnail for listing ${listingId}`)
    thumbnailUrl.value = storeUrl
    return
  }

  // Check if already loading in store
  if (storeLoadingState.value) {
    console.log(`Thumbnail already loading for listing ${listingId}`)
    return
  }

  // Fetch from store (which handles caching)
  console.log(`Fetching thumbnail for listing ${listingId} via store`)
  const url = await thumbnailStore.fetchThumbnail(listingId)

  if (url) {
    thumbnailUrl.value = url
  } else {
    thumbnailUrl.value = '/img/placeholder_listing_img.png'
  }
}

// Watch for property changes
watch(
  () => [props.property?.listing_id, props.preloadedThumbnail],
  (newValues, oldValues) => {
    // Safely destructure with default values to prevent undefined errors
    const [newListingId, newPreloadedThumbnail] = newValues || []
    const [oldListingId, oldPreloadedThumbnail] = oldValues || []

    if (
      newListingId !== oldListingId ||
      newPreloadedThumbnail !== oldPreloadedThumbnail
    ) {
      console.log(
        `Property or preloaded thumbnail changed for listing ${newListingId}`
      )
      fetchThumbnail()
    }
  },
  { immediate: true }
)

// Watch for store changes
watch(storeThumbnailUrl, (newUrl) => {
  if (newUrl && props.property?.listing_id) {
    console.log(
      `Store thumbnail updated for listing ${props.property.listing_id}`
    )
    thumbnailUrl.value = newUrl
  }
})

// Expose cache stats for debugging
const getCacheStats = () => {
  return thumbnailCache.getCacheStats()
}

// Expose cache clearing for debugging
const clearCache = () => {
  thumbnailCache.clearAllCache()
  console.log('Thumbnail cache cleared')
}
</script>

<style scoped>
/* Add any specific styles for the card here */
</style>
