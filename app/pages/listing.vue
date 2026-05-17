<template>
  <div class="p-4 md:flex md:gap-4">
    <div class="w-full md:w-8/12">
      <!-- Listing name -->
      <h3 class="text-2xl font-black uppercase">{{ listing.name }}</h3>

      <!-- Location -->
      <div class="mb-4 text-sm font-medium whitespace-no-wrap text-muted-foreground">
        <span>
          {{ listing.unit_number }} {{ listing.street }}
          {{ listing['city.name'] }}</span
        >
        <div class="inline-flex text-3xl align-middle">
          <MapMarkerOutlineIcon class="text-primary" />
        </div>
      </div>

      <!-- Single Image -->
      <div class="relative" v-if="!!listing.images && !!listing.images.length">
        <div class="bg-red"></div>
        <img
          v-lazy="listing.images[selectedImageIndex]"
          :key="selectedImageIndex"
          class="object-contain w-full h-64 rounded-md md:h-135"
          alt="Image"
        />
        <button
          v-if="!!parseInt(listing.watermark_agreement)"
          @click="showDownloadAllPhotosModal()"
          class="absolute px-2 py-1 m-2 text-xs font-bold text-white whitespace-no-wrap transition ease-in-out delay-100 bg-foreground/50 rounded-md top-1 right-1 md:top-4 md:right-4 md:text-sm md:px-4 md:py-2 hover:bg-black"
        >
          Download all photos
          <div class="inline-flex pl-2 text-3xl align-middle">
            <ImageIcon class="text-white" />
          </div>
        </button>
      </div>

      <!-- Image Gallery -->
      <div
        class="flex w-full pb-2 mt-2 overflow-x-auto"
        v-if="!!listing.images"
      >
        <img
          v-for="(image, index) in listing.images"
          :key="index"
          @click="selectImage(index)"
          v-lazy="image"
          class="object-cover w-16 h-12 mr-2 rounded-md shadow-lg cursor-pointer md:w-28 md:h-20"
          :alt="`image-${index}`"
        />
      </div>
      <p
        class="py-4 mb-4 text-sm font-medium text-muted-foreground"
        v-html="sanitizeListingHtml(listing.description)"
      ></p>

      <!-- Amenitites -->
      <div class="mb-8">
        <h3 class="text-xl font-bold text-foreground">
          Building Amenities & Unit Features
        </h3>
        <div
          class="grid grid-flow-row-dense grid-cols-3 gap-3 mt-4"
          v-if="listing && listing.amenities"
        >
          <div
            v-for="(amenity, index) in listing.amenities"
            :key="index"
            class="flex text-sm font-bold"
          >
            <CheckIcon class="pr-2 md:pr-2" />
            <span class="my-auto text-xs text-foreground md:text-sm">
              {{ amenity.name }}
            </span>
          </div>
        </div>
      </div>

      <!-- Other building details -->
      <div class="mb-8">
        <h3 class="text-xl font-bold text-foreground">Other building details</h3>
        <div
          class="grid grid-flow-row-dense grid-cols-2 gap-3 mt-4 md:grid-cols-4"
          v-if="listing"
        >
          <div class="text-center">
            <div class="font-bold uppercase text-foreground">CLASS</div>
            <div class="text-sm text-foreground">
              {{ listing.telcos || 'No' }}
            </div>
          </div>
          <div class="text-center">
            <div class="font-bold uppercase text-foreground">YEAR BUILT</div>
            <div class="text-sm text-foreground">
              {{ listing.telcos || 'No' }}
            </div>
          </div>
          <div class="text-center">
            <div class="font-bold uppercase text-foreground">PEZA</div>
            <div class="text-sm text-foreground">
              {{ listing.telcos || 'No' }}
            </div>
          </div>
          <div class="text-center">
            <div class="font-bold uppercase text-foreground">TELCOS</div>
            <div class="text-sm text-foreground">
              {{ listing.telcos || 'No' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="w-full md:w-4/12 md:pl-4">
      <!-- Price -->
      <div class="flex">
        <div class="flex flex-col gap-4 mx-auto text-xs md:flex-row md:text-sm">
          <div
            class="flex justify-between py-1 pl-4 pr-1 rounded-l-full rounded-r-full bg-primary/10"
            v-if="!!listing.rent_price"
          >
            <div class="w-auto px-2 my-auto font-bold text-center">
              Rental Price
            </div>
            <div
              class="px-4 py-2.5 font-bold text-center w-auto bg-primary rounded-l-full rounded-r-full text-white break-words"
            >
              {{ listing.formatted_rent_price }}
            </div>
          </div>
          <div
            class="flex justify-between py-1 pl-4 pr-1 rounded-l-full rounded-r-full bg-primary/10"
            v-if="!!listing.sale_price"
          >
            <div class="w-auto px-2 my-auto font-bold text-center">
              Sale Price
            </div>
            <div
              class="px-4 py-2.5 font-bold text-center w-auto bg-primary rounded-l-full rounded-r-full text-white break-words"
            >
              {{ listing.formatted_sale_price }}
            </div>
          </div>
        </div>
      </div>
      <h3 class="mt-6 mb-2 text-xl font-black" v-if="false">
        Apply to Co-list
      </h3>
      <div
        class="p-4 bg-card border-solid rounded-md shadow-xl border-1 border-border"
        v-if="false"
      >
        <!-- Title -->
        <h3 class="font-black uppercase text-md">{{ listing.name }}</h3>

        <!-- Location -->
        <div class="mb-8 text-sm font-medium whitespace-no-wrap text-muted-foreground">
          <span>
            {{ listing.unit_number }} {{ listing.street }}
            {{ listing['city.name'] }}</span
          >
          <div class="inline-flex text-3xl align-middle">
            <MapMarkerOutlineIcon class="text-primary" />
          </div>
        </div>

        <div class="pb-2 text-xs font-bold">Write the agent a message</div>
        <textarea
          placeholder="Message"
          class="w-full p-4 text-sm rounded-md bg-muted focus:border-0"
          cols="15"
        ></textarea>
        <div class="flex gap-1">
          <button
            type="button"
            class="w-full my-auto rounded-lg h-9 bg-muted hover:bg-muted-foreground"
          >
            <span class="inline-block text-white font-bold mt-0.5">Cancel</span>
          </button>
          <button
            type="button"
            class="w-full my-auto rounded-lg h-9 bg-green focus:bg-green hover:bg-green-dark"
          >
            <span class="inline-block text-white font-bold mt-0.5">Submit</span>
          </button>
        </div>
      </div>

      <h3 class="mt-6 mb-2 text-xl font-black" v-if="false">Co-list Terms</h3>
      <div class="p-4 bg-muted/50" v-if="false">
        <div class="font-bold">Showings</div>
        <div class="text-sm text-foreground">Shared responsibility</div>
      </div>
      <div class="p-4 bg-muted/50" v-if="false">
        <div class="font-bold">Commision</div>
        <div class="text-sm text-foreground">
          40% Parther Broker | 40% Co-Broker | 20% Housing Interactive
        </div>
      </div>
    </div>
    <DownloadAllPhotosModal
      :listingId="listingId"
      :isModalOpen="isModalOpen"
      @isFetching="isLoading = true"
      @isDoneFetching="isLoading = false"
      @close="isModalOpen = false"
    />
  </div>
</template>

<script>
import { apiRoutes } from '~/contants'
import DownloadAllPhotosModal from '~/components/pages/listings/DownloadAllPhotosModal'
import Gallery from '~/components/pages/listings/Gallery'
import {
  formatCurrency,
  showLoading,
  dismissLoading,
  showToast,
} from '~/helpers/helpers'
// Icons
import MapMarkerOutlineIcon from 'vue-material-design-icons/MapMarkerOutline.vue'
import ImageIcon from 'vue-material-design-icons/Image.vue'
import CheckIcon from 'vue-material-design-icons/Check.vue'

export default {
  middleware: ['auth'],
  components: {
    DownloadAllPhotosModal,
    Gallery,
    MapMarkerOutlineIcon,
    ImageIcon,
    CheckIcon,
  },
  data() {
    return {
      selectedImageIndex: 0,
      listingId: null,
      listing: {},
      singleListingUrl: apiRoutes['listings.show'],
      isModalOpen: false,
    }
  },
  mounted() {
    this.listingId = this.$route.params.id
  },
  watch: {
    listingId(listingId) {
      if (!!listingId) {
        this.getSingleListing(listingId)
      }
    },
  },
  methods: {
    selectImage(index) {
      this.selectedImageIndex = index
    },
    showDownloadAllPhotosModal() {
      this.isModalOpen = true
    },
    getSingleListing(listingId = null) {
      this.isLoading = true
      if (!listingId) {
        return true
      }
      showLoading()
      $fetch(this.singleListingUrl.replace('/:id', `/${listingId}`)).then(
        (data) => {
          dismissLoading()
          this.isLoading = false
          let listings = data
          /**
           * Preprocess
           */
          listings.metadata = JSON.parse(listings.metadata)
          listings['formatted_rent_price'] = `${formatCurrency(
            listings.rent_price || 0
          )}/monthly`
          listings['formatted_sale_price'] = formatCurrency(
            listings.sale_price || 0
          )
          this.listing = listings
        },
        () => {
          this.isLoading = false
        }
      )
    },
  },
}
</script>
