<template>
  <div class="px-6 pt-6 pb-3">
    <div class="flex mb-6 h-112">
      <div class="flex-1 mr-3 h-112">
        <div v-if="hasCurrentImage">
          <img
            class="object-cover w-full h-112"
            :src="currentImage.url"
            alt="Image"
          />
          <p class="py-2 text-center">{{ currentImage.name }}</p>
        </div>
      </div>

      <div class="relative h-full">
        <div
          v-if="images.length > 6"
          @click="scrollUp"
          class="absolute top-0 text-center bg-card opacity-50 cursor-pointer w-28 h-9"
        >
          <ChevronUp class="inline-block" :size="32" />
        </div>
        <div ref="thumbnails" class="h-full overflow-hidden">
          <div class="flex flex-col">
            <div
              v-for="(image, index) in images"
              :key="index"
              @click="setCurrentImage(index)"
              :ref="`image-${index}`"
              class="h-20 mb-3 overflow-hidden rounded cursor-pointer w-28"
            >
              <img
                v-if="images"
                class="object-cover h-20 w-28"
                :src="image.url"
                alt="Image"
              />
            </div>
          </div>
        </div>
        <div
          v-if="images.length > 6"
          @click="scrollDown"
          class="absolute bottom-0 text-center bg-card opacity-50 cursor-pointer w-28 h-9"
        >
          <ChevronDown class="inline-block" :size="32" />
        </div>
      </div>
    </div>
    <div class="mt-10 text-lg font-medium text-center text-foreground pr-28">
      <span>{{ currentImageIndex + 1 }}</span> /
      <span>{{ images.length }}</span>
    </div>
  </div>
</template>

<script>
import Modals from '~/mixins/modals'
import ChevronDown from 'vue-material-design-icons/ChevronDown.vue'
import ChevronUp from 'vue-material-design-icons/ChevronUp.vue'
import Close from 'vue-material-design-icons/Close.vue'
import { apiRoutes } from '~/contants'
import { dismissLoading, showLoading, showToast } from '~/helpers/helpers'

function scrollTop(e, scrollTop, duration = 300) {
  const originalScrollTop = e.scrollTop
  let currentScrollTop = originalScrollTop

  if (currentScrollTop === scrollTop) {
    return
  }

  const distance = Math.abs(scrollTop - currentScrollTop)
  const step = duration / distance

  function frame() {
    currentScrollTop =
      scrollTop > currentScrollTop
        ? currentScrollTop + step
        : currentScrollTop - step
    e.scrollTop = currentScrollTop
    if (originalScrollTop < scrollTop && currentScrollTop >= scrollTop) {
      clearInterval(id)
    } else if (originalScrollTop > scrollTop && currentScrollTop <= scrollTop) {
      clearInterval(id)
    }
  }
  const id = setInterval(frame, 1)
}

export default {
  mixins: [Modals],
  props: {
    value: {
      default: null,
    },
    listingId: [String, Number],
  },
  components: { ChevronDown, ChevronUp, Close },
  data() {
    return {
      name: '',
      images: [],
      currentImageIndex: 0,
      currentImage: null,
      scrollTopIndex: 0,
      hasCurrentImage: false,
    }
  },
  computed: {
    isVisible() {
      return !!this.value
    },
  },
  methods: {
    async fetchImages() {
      //showLoading();
      try {
        this.images = await $fetch(
          apiRoutes['listings.images'].replace(':id', this.listingId)
        )
        this.setCurrentImage(0)
      } catch (error) {
        //showToast({ title: 'Something went wrong fetching images. Please try again later.' })
      }
      //dismissLoading();
    },

    setCurrentImage(index) {
      this.currentImageIndex = index
      this.currentImage = this.images[index]
      this.hasCurrentImage = this.currentImage ? true : false
    },

    close() {
      this.$emit('close')
    },

    scrollUp() {
      if (this.scrollTopIndex > 0) {
        this.scrollTopIndex--
        scrollTop(
          this.$refs['thumbnails'],
          this.$refs[`image-${this.scrollTopIndex}`][0].offsetTop
        )
      }
    },

    scrollDown() {
      if (this.scrollTopIndex < this.images.length - 6) {
        this.scrollTopIndex++
        scrollTop(
          this.$refs['thumbnails'],
          this.$refs[`image-${this.scrollTopIndex}`][0].offsetTop
        )
      }
    },
  },

  mounted() {
    if (this.listingId) {
      this.fetchImages()
    }
  },
}
</script>
