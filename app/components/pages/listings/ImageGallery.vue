<template>
  <div
    class="absolute top-0 left-0 w-full h-full bg-[rgba(100,100,100,0.75)] z-[1000] flex justify-center items-center"
    v-if="props.imageGalleryOpen"
  >
    <div class="w-[55vw] min-h-[40vw] bg-card rounded-lg flex flex-col gap-4">
      <div class="flex justify-between items-center p-[1.2vw]">
        <div class="flex flex-col gap-2">
          <span class="text-lg font-semibold">Photo Gallery</span>
          <span class="text-md text-muted-foreground"
            >{{ images.length ? images.length : 0 }} images</span
          >
        </div>
        <div
          class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 h-[1.5vw] w-[1.5vw] hover:bg-primary/10 mr-2"
          @click="toggleImageGallery"
          :class="{ 'bg-primary/10': imageGalleryOpen }"
        >
          <font-awesome-icon
            icon="close"
            class="text-gray-350 group-hover:text-primary"
            size="md"
          />
        </div>
      </div>
      <!-- Divider -->
      <div class="w-full h-[1px] bg-muted"></div>
      <!-- Image Gallery -->
      <div v-if="images.length > 0" class="flex gap-4 p-4 rounded-lg">
        <!-- Main Image -->
        <div class="flex-1">
          <img
            :src="selectedImage"
            alt="Main Image"
            class="rounded-lg shadow-lg w-full max-h-[24vw]"
          />
        </div>

        <Splide
          ref="thumbSplide"
          class="thumbnails"
          :options="{
            fixedWidth: 100,
            fixedHeight: 100,
            isNavigation: true,
            gap: 10,
            direction: 'ttb',
            height: 500,
            pagination: false,
            cover: true,
            scroll: 'free',
          }"
        >
          <SplideSlide
            v-for="img in images"
            :key="img"
            @click="changeSelectedImage(img)"
          >
            <img :src="img" class="thumbnail" />
          </SplideSlide>
        </Splide>
      </div>
      <div
        v-if="images.length > 0"
        class="flex justify-center items-center p-4 w-full"
      >
        <span class="font-semibold text-foreground"
          >{{ currentIndex + 1 }} / {{ images.length }}</span
        >
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { Splide, SplideSlide } from '@splidejs/vue-splide'
import '@splidejs/splide/dist/css/splide.min.css'
import axios from 'axios'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import listingServices from '~/services/listing.services'

const props = defineProps({
  imageGalleryOpen: {
    type: Boolean,
    default: false,
  },
  listingId: {
    type: Number,
    default: 0,
  },
})

const images = ref<string[]>([])
const selectedImage = ref<string>('')
const currentIndex = ref(0)

// Watch for changes in imageGalleryOpen to initialize the gallery
watch(
  () => props.imageGalleryOpen,
  async (newVal) => {
    if (newVal && props.listingId) {
      console.log('props.listingId: ', props.listingId)
      showLoading()
      try {
        const response = await listingServices._getGalleryImages(props.listingId)
        const listingImages = response ? (response as unknown as string[]) : []
        images.value = listingImages

        console.log('images: ', images.value)
        
        if (listingImages.length === 0) {
          showToast({
            title: 'No images found for this listing',
            icon: 'info'
          })
        }
      } catch (error) {
        console.error('Error loading gallery images:', error)
        showToast({
          title: 'Error loading images',
          icon: 'error'
        })
        images.value = []
      } finally {
        dismissLoading()
      }
    }
  }
)

// Set initial selected image once gallery is loaded
watchEffect(() => {
  if (images.value.length > 0 && !selectedImage.value) {
    selectedImage.value = images.value[0]
  }
})

const changeSelectedImage = (image: string) => {
  selectedImage.value = image
  currentIndex.value = images.value.indexOf(image)
}

onUnmounted(() => {
  images.value = []
})

const emit = defineEmits(['toggleImageGallery'])

const toggleImageGallery = () => {
  emit('toggleImageGallery')
}
</script>

<style scoped>
.carousel-container {
  display: flex;
  align-items: center;
  gap: 15px;
}

.thumbnails {
  width: 120px;
}

.thumbnail {
  cursor: pointer;
  border-radius: 5px;
  transition: transform 0.2s ease-in-out;
}

.thumbnail:hover {
  transform: scale(1.1);
}

.main-carousel {
  flex: 1;
  max-width: 600px;
}

.main-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
}
</style>
