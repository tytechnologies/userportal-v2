<template>
  <div
    class="flex relative gap-2 items-center h-full whitespace-no-wrap"
    :class="className"
  >
    <div class="inline-block group">
      <button
        class="flex items-center px-3 py-1 rounded-sm outline-none focus:outline-none"
      >
        <span class="flex-1 pr-1 text-base font-bold">Actions</span>
        <span>
          <svg
            class="w-4 h-4 transition duration-150 ease-in-out transform fill-current group-hover:-rotate-180"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
          >
            <path
              d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"
            />
          </svg>
        </span>
      </button>
      <ul
        :class="['absolute z-50 -top-20 right-5 bg-card rounded-sm border transition duration-150 ease-in-out transform origin-top scale-0 group-hover:scale-100 w-36 lg:min-w-[10vw]']"
      >
        <!-- <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          v-if="userCanSeeOverview(row.uploader_id)"
        >
          <a :href="overviewUrl">
            <button
              type="button"
              title="Overview"
              class="h-6 text-md text-primary text-center"
            >
              <font-awesome-icon icon="chart-line" /> Overview
            </button>
          </a>
        </li> -->
        <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          v-if="userCanEditOtherListings"
          type="button"
          title="Edit Listing"
        >
          <button
            class="h-6 text-md text-primary text-center"
            @click="showUpdateListing(row.listing_data)"
          >
            <font-awesome-icon icon="pen-to-square" /> Edit Listing
          </button>
        </li>
        <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          v-if="userCanEditOtherListings"
          type="button"
          title="Clone Listing"
        >
          <button
            class="h-6 text-md text-primary text-center"
            @click="showCloneListing(row)"
          >
            <font-awesome-icon icon="clone" /> Clone listing
          </button>
        </li>
        <!-- <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          v-if="
            isUserHasPermission('properties.upsert')
            // || row.uploader_id == $auth.user['id']
          "
          type="button"
          title="Archive Listing"
        >
          <button
            v-if="row.listing_data.is_online"
            class="h-6 text-md text-primary"
            @click="showConfirmArchive(row)"
          >
            <font-awesome-icon icon="box-archive" /> Archive listing
          </button>
          <buttonx
            v-else
            class="h-6 text-md text-primary"
            @click="showConfirmUnarchive(row)"
          >
            <font-awesome-icon icon="box-archive" /> Unarchive listing
          </button>
        </li> -->
        <li class="relative px-3 py-1 rounded-sm hover:bg-muted">
          <button
            type="button"
            title="Show Remarks"
            class="h-6 text-md text-primary text-center"
            @click="showRemarksModal(row)"
          >
            <font-awesome-icon icon="circle-info" /> Remarks
          </button>
        </li>
        <li class="relative px-3 py-1 rounded-sm hover:bg-muted">
          <button
            type="button"
            title="Download Images"
            class="h-6 text-md text-primary text-left"
            @click="showDownloadModal(row)"
          >
            <font-awesome-icon icon="download" /> Download Images
          </button>
        </li>
        <!-- <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          v-if="
            isUserHasPermission('properties.upsert')
            // || row.uploader_id == $auth.user['id']
          "
          type="button"
        >
          <button
            class="h-6 text-md text-primary text-left"
            @click="toggleAddToDeck(row.id)"
          >
            <template v-if="addedToDeck">
              <font-awesome-icon icon="folder-minus" title="Remove from deck" />
              Remove from deck
            </template>
            <template v-else>
              <font-awesome-icon icon="folder-plus" title="Add to deck" /> Add
              to deck
            </template>
          </button>
        </li> -->
        <!-- History — opens the change-history drawer. Reads from the
             activities audit table; populated by the listings_audit_diff
             trigger (migration 20260507000007). -->
        <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          type="button"
          title="History"
        >
          <button
            class="h-6 text-md text-primary text-center"
            @click="showHistory(row.listing_data.listing_id)"
          >
            <font-awesome-icon icon="clipboard-list" /> History
          </button>
        </li>
        <!-- <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          v-if="
            isUserHasPermission('properties.upsert')
            // || row.uploader_id == $auth.user['id']
          "
          type="button"
          title="History Logs"
        >
          <button
            class="h-6 text-md text-primary text-center"
            @click="showPropertyLogs(row.id)"
          >
            <font-awesome-icon icon="scroll" /> Call Logs
          </button>
        </li> -->
        <li
          class="relative px-3 py-1 rounded-sm hover:bg-muted"
          v-if="
            userCanDeleteListings
            // || row.uploader_id == $auth.user['id']
          "
          type="button"
          title="Delete Listing"
        >
          <button
            class="h-6 text-md text-primary text-center"
            @click="
              showConfirmDelete(
                row.listing_data.listing_id,
                row.listing_data.title,
                index
              )
            "
          >
            <font-awesome-icon icon="trash" /> Delete listing
          </button>
        </li>
      </ul>
    </div>

    <Modal
      :title="`Listing Remarks - ${row.listing_data.listing_id}`"
      ref="listingRemarksModal"
    >
      <div class="p-4">
        <RemarksForm
          :listing="row"
          @submitCallback="updateListingRemarks"
          ref="listingRemarksForm"
        />
      </div>
    </Modal>

    <Modal
      :title="`Download Images - ${row.listing_data.listing_id}`"
      ref="downloadOptionsModal"
    >
      <div class="p-6">
        <div class="mb-6">
          <p class="text-foreground mb-4">Select how you want to download your images:</p>
          
          <div class="space-y-4">
            <!-- Option 1: With Watermark -->
            <label class="flex items-center p-4 border-2 border-border rounded-lg cursor-pointer hover:border-blue hover:bg-primary/10" :class="{'border-blue bg-primary/10': downloadWithWatermark}">
              <input 
                type="radio" 
                v-model="downloadWithWatermark" 
                :value="true"
                class="w-4 h-4 text-primary"
              />
              <div class="ml-4">
                <p class="font-semibold text-foreground">Download with Watermark</p>
                <p class="text-sm text-muted-foreground">Images will include the agency watermark</p>
              </div>
            </label>

            <!-- Option 2: Without Watermark -->
            <label class="flex items-center p-4 border-2 border-border rounded-lg cursor-pointer hover:border-blue hover:bg-primary/10" :class="{'border-blue bg-primary/10': !downloadWithWatermark}">
              <input 
                type="radio" 
                v-model="downloadWithWatermark" 
                :value="false"
                class="w-4 h-4 text-primary"
              />
              <div class="ml-4">
                <p class="font-semibold text-foreground">Download without Watermark</p>
                <p class="text-sm text-muted-foreground">Original images without any watermark</p>
              </div>
            </label>
          </div>
        </div>

        <div class="flex gap-3 justify-end">
          <button
            @click="closeDownloadModal"
            class="px-4 py-2 text-foreground bg-muted rounded-lg hover:bg-muted transition"
          >
            Cancel
          </button>
          <button
            @click="processDownload"
            class="px-4 py-2 text-white bg-blue rounded-lg hover:bg-primary transition"
          >
            Download
          </button>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style>
/* since nested groupes are not supported we have to use 
        regular css for the nested dropdowns 
    */
li > ul {
  transform: translatex(100%) scale(0);
}
li:hover > ul {
  transform: translatex(101%) scale(1);
}
/* li > button svg       { transform: rotate(-90deg) } */
/* li:hover > button svg { transform: rotate(-270deg) } */

/* Below styles fake what can be achieved with the tailwind config
        you need to add the group-hover variant to scale and define your custom
        min width style.
        See https://codesandbox.io/s/tailwindcss-multilevel-dropdown-y91j7?file=/index.html
        for implementation with config file
    */
.group:hover .group-hover\:scale-100 {
  transform: scale(1);
}
/* .group:hover .group-hover\:-rotate-180 { transform: rotate(180deg) } */
.scale-0 {
  transform: scale(0);
}
.min-w-32 {
  min-width: 8rem;
}
</style>

<script>
import { apiRoutes } from '~/contants'
import ImagesController from '@/services/images/imagesController'
import listingService from '@/services/listing.services'
import authService from '@/services/auth.services'
import Swal from 'sweetalert2'
import { dismissLoading, showLoading, showToast } from '@/helpers/helpers'
import { useListingColumnsAtom } from '@/store/index'
import { useGeneralStore } from '@/store/generalStore'
import { library } from '@fortawesome/fontawesome-svg-core'
import axios from 'axios'
import JSZip from 'jszip'
import { can } from '~/composables/useAuth'
//import specific icons
import {
  faPenToSquare,
  faCircleInfo,
  faClone,
  faBoxArchive,
  faDownload,
  faTrash,
  faClipboard,
  faChartLine,
  faFolderPlus,
  faFolderMinus,
  faScroll,
  faClipboardList,
} from '@fortawesome/free-solid-svg-icons'

library.add(
  faPenToSquare,
  faDownload,
  faCircleInfo,
  faClone,
  faBoxArchive,
  faTrash,
  faClipboard,
  faChartLine,
  faFolderPlus,
  faFolderMinus,
  faScroll,
  faClipboardList
)

export default {
  mixins: [authService, listingService],
  data() {
    return {
      listingRemarks: '',
      selectedListingId: null,
      listingColumnsStore: useListingColumnsAtom(),
      addedToDeck: this.row.added_to_deck,
      generalStore: useGeneralStore(),
      downloadWithWatermark: true,
      pendingDownloadListing: null,
    }
  },
  props: {
    className: {
      type: String,
      default: '',
    },
    index: Number,
    row: Object,
  },

  emit: ['getListings'],

  computed: {
    userCanEditOtherListings() {
      if (this.generalStore.listingShowingType === 'personal') return true
      if (this.generalStore.listingShowingType === 'broker') return can('edit_any_listing')
      return false
    },
    userCanDeleteListings() {
      if (this.generalStore.listingShowingType === 'personal') return true
      if (this.generalStore.listingShowingType === 'broker') return can('delete_any_listing')
      return false
    },
    overviewUrl() {
      return `/dashboard/${this.row.id}`
    },

    historyUrl() {
      return `/listing/history/${this.row.id}`
    },
  },
  async mounted() {
    console.log('row: ', this.row)
  },
  watch: {
    'generalStore.listingShowingType': {
      handler(newVal, oldVal) {
        console.log('generalStore.listingShowingType newVal: ', newVal)
        console.log('generalStore.listingShowingType oldVal: ', oldVal)
      },
      deep: true,
    },
  },
  methods: {
    userCanSeeOverview(uploader_id) {
      // WIP
      //   if (this.$auth.user.designation == 'administrator') {
      //     return true
      //   }
      //   if (uploader_id == this.$auth.user.id) {
      //     return true
      //   }
      //   return false

      return true
    },
    isUserHasPermission(key) {
      // WIP
      //   return this._isUserHasPermission(key)
      return true
    },
    showUpdateListing(listingData) {
      this.updateListingId = listingData.listing_id
      this.$emit('showUpdateListing', listingData)
    },
    showDownloadModal(listing) {
      // Store the listing for later processing
      this.pendingDownloadListing = listing
      this.downloadWithWatermark = true // Default to with watermark
      // Open the modal to show options
      this.$refs.downloadOptionsModal.toggleModal()
    },

    closeDownloadModal() {
      this.pendingDownloadListing = null
      this.$refs.downloadOptionsModal.toggleModal()
    },

    async processDownload() {
      if (!this.pendingDownloadListing) {
        showToast({
          title: 'No listing selected',
          icon: 'error'
        })
        return
      }

      try {
        showLoading()
        const listing = this.pendingDownloadListing
        
        // Use server API to get image URLs with watermark preference
        const response = await $fetch('/api/listings/image-download', {
          method: 'POST',
          body: { 
            listingId: listing.listing_data.listing_id,
            withWatermark: this.downloadWithWatermark
          }
        })

        if (!response.success || !response.data || response.data.length === 0) {
          showToast({
            title: 'No images found to download',
            icon: 'info'
          })
          dismissLoading()
          return
        }

        const urls = response.data
        console.log('urls: ', urls)
        console.log('Download with watermark:', this.downloadWithWatermark)
        
        // zip the images from the urls
        const zip = new JSZip()
        for (const urlData of urls) {
          const response = await fetch(urlData.signedUrl)
          const blob = await response.blob()
          const fileName = urlData.object.Key.split('/').pop()
          zip.file(fileName, blob)
        }

        const content = await zip.generateAsync({ type: 'blob' })
        const url = URL.createObjectURL(content)
        const a = document.createElement('a')
        a.href = url
        
        // Add watermark/original indicator to filename
        const watermarkLabel = this.downloadWithWatermark ? 'watermarked' : 'original'
        a.download = `${listing.listing_data.title}_${listing.listing_data.listing_id}_${watermarkLabel}_images.zip`
        a.click()
        
        // Cleanup
        setTimeout(() => URL.revokeObjectURL(url), 100)
        
        // Close modal and show success message
        this.closeDownloadModal()
        showToast({
          title: 'Images downloaded successfully',
          icon: 'success'
        })
        dismissLoading()
      } catch (error) {
        console.error('Error downloading images:', error)
        showToast({
          title: 'Error downloading images',
          icon: 'error'
        })
        dismissLoading()
      }
    },
    showCloneListing(listing) {
      Swal.fire({
        title: 'Clone Listing',
        html: `Are you sure you want to clone <b>${listing.listing_data.title}</b>?`,
        confirmButtonColor: '#E73F31',
        confirmButtonText: 'Confirm',
        showCancelButton: true,
      }).then(async (result) => {
        if (result.isConfirmed) {
          showLoading()
          try {
            const clonedListing = await this.listingColumnsStore.cloneListing(
              listing.listing_data.listing_id
            )
            showToast({
              title: `Listing "${clonedListing.title}" cloned successfully!`,
              icon: 'success',
            })
          } catch (error) {
            console.error('Clone error:', error)
            showToast({
              title: error.message || 'Failed to clone listing',
              icon: 'warning',
            })
            return
          }
          dismissLoading()
          this.$emit('getListings')
          window.location.reload()
        }
      })
    },
    showConfirmArchive(listing) {
      // Optimistic + undo: skip the confirm modal, archive immediately, and
      // give the user 8s to undo via the toast action button. Matches the
      // Linear/Gmail pattern.
      this.archiveListing(listing.listing_data.listing_id, listing.listing_data.title)
    },
    async archiveListing(id, title = '') {
      try {
        await this.listingColumnsStore.archiveListing(id)
      } catch (error) {
        showToast({
          title: 'Something went wrong archiving the listing. Please try again.',
          icon: 'warning',
        })
        this.$emit('getListings')
        return
      }
      this.$emit('getListings')
      showToast({
        title: title ? `Archived "${title}".` : 'Listing archived.',
        icon: 'success',
        button: { text: 'Undo' },
        onButtonClick: async () => {
          try {
            await this.listingColumnsStore.unarchiveListing(id)
            showToast({ title: 'Restored.', icon: 'success' })
          } catch (e) {
            showToast({ title: 'Could not undo. Please try again.', icon: 'error' })
          } finally {
            this.$emit('getListings')
          }
        },
      })
    },
    showConfirmUnarchive(listing) {
      this.unarchiveListing(listing.listing_data.listing_id, listing.listing_data.title)
    },
    async unarchiveListing(id, title = '') {
      try {
        await this.listingColumnsStore.unarchiveListing(id)
      } catch (error) {
        showToast({
          title: 'Something went wrong unarchiving the listing. Please try again.',
          icon: 'warning',
        })
        this.$emit('getListings')
        return
      }
      this.$emit('getListings')
      showToast({
        title: title ? `Unarchived "${title}".` : 'Listing unarchived.',
        icon: 'success',
        button: { text: 'Undo' },
        onButtonClick: async () => {
          try {
            await this.listingColumnsStore.archiveListing(id)
            showToast({ title: 'Re-archived.', icon: 'success' })
          } catch (e) {
            showToast({ title: 'Could not undo. Please try again.', icon: 'error' })
          } finally {
            this.$emit('getListings')
          }
        },
      })
    },
    showPropertyLogs(id) {
      this.$emit('showPropertyLogs', id)
    },
    showHistory(id) {
      this.$emit('showHistory', id)
    },
    async showConfirmDelete(id, name, index) {
      const { confirm } = useConfirm()
      const ok = await confirm({
        title: 'Delete listing?',
        description: `Are you sure you want to delete "${name}"? This action cannot be undone.`,
        confirmText: 'Delete',
        variant: 'destructive',
      })
      if (!ok) return
      this.deleteListing(id, index)
    },
    async deleteListing(id, index) {
      await showLoading()
      console.log('id: ', id)
      await this.listingColumnsStore.deleteListing(id)
      dismissLoading()
      this.$emit('getListings')
    },
    showRemarksModal(listing) {
      console.log('listing opened for Remarks: ', listing)
      this.selectedListingId = listing.listing_data.listing_id
      console.log('this.listingRemarks: ', this.listingRemarks)
      this.$refs.listingRemarksModal.toggleModal()
    },
    // async updateListingRemarks() {
    //   showLoading()
    //   try {
    //     await this.listingColumnsStore.updateListingRemarks(
    //       this.selectedListingId,
    //       this.listingRemarks
    //     )
    //     showToast({
    //       title: 'Listing remarks updated successfully.',
    //       icon: 'success',
    //     })
    //     this.$emit('getListings')
    //     this.$refs.listingRemarksModal.toggleModal()
    //   } catch (error) {
    //     console.error('Error updating remarks:', error)
    //     showToast({
    //       title: 'Failed to update remarks. Please try again.',
    //       icon: 'error',
    //     })
    //   } finally {
    //     dismissLoading()
    //   }
    // },
    // async toggleAddToDeck(listingId) {
    //   await showLoading()
    //   const body = { listing_id: listingId }
    //   const url = this.addedToDeck
    //     ? apiRoutes['listings.deck.remove']
    //     : apiRoutes['listings.deck.add']
    //   this.$axios
    //     .$post(url, body)
    //     .then((res) => {
    //       dismissLoading()
    //       const title = this.addedToDeck
    //         ? 'Property removed from deck'
    //         : 'Property added to deck.'
    //       this.addedToDeck = !this.addedToDeck
    //       this.$emit('onDeckToggled')
    //       showToast({ title })
    //     })
    //     .catch(() => {
    //       dismissLoading()
    //       alert('Oops. Something went wrong. Please try again later.')
    //     })
    // },
  },
}
</script>
