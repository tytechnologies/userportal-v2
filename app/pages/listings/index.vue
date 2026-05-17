<script setup lang="ts">
import { ref, computed, onMounted, reactive, nextTick, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiTabBar from '~/components/ui/UiTabBar.vue'
import {
  showLoading,
  dismissLoading,
  showToast,
  showSwal,
  currencySuffix,
} from '~/helpers/helpers'
import {
  useListingsRawAtom,
  useListingColumnsAtom,
  fetchListingsEnded,
} from '~/store'
import {
  ListingRawSchema,
  ListingColumnsSchema,
  ListingImagesSchema,
} from '~/types'
import type { InferType } from 'yup'
import * as yup from 'yup'
// Lazy-load AdvanceFilters — it's a 700+ line modal that's only mounted
// when the user clicks "Advanced Filters", so deferring its bundle keeps
// the listings page initial chunk smaller. Resolved on first open.
const AdvanceFilters = defineAsyncComponent(
  () => import('~/components/pages/listings/AdvanceFilters.vue'),
)
import CloneForm from '~/components/pages/listings/CloneForm.vue'
import NewForm from '~/components/pages/listings/NewForm.vue'
import Gallery from '~/components/pages/listings/Gallery.vue'
import LogForm from '~/components/pages/listings/LogForm.vue'
import LogList from '~/components/pages/listings/LogList.vue'
import Modal from '~/components/Modal.vue'
import QuickUpdateForm from '~/components/pages/listings/QuickUpdateForm.vue'
import RemarksForm from '~/components/pages/listings/RemarksForm.vue'
import SearchSection from '~/components/pages/listings/Search.vue'
import SelectedPropertyPreview from '~/components/pages/listings/SelectedPropertyPreview.vue'
import Settings from '~/components/pages/listings/Settings.vue'
import ListingsTable from '~/components/ListingsTable.vue'
import ListingsCardGrid from '~/components/listings/ListingsCardGrid.vue'
import ListingHistoryDrawer from '~/components/listings/ListingHistoryDrawer.vue'
import ContactValidation from '~/components/pages/listings/ContactValidation.vue'
import ListingService from '~/services/listing.services'

import SidebarListingDetails from '~/components/pages/listings/SidebarListingDetails.vue'
import ImageGallery from '~/components/pages/listings/ImageGallery.vue'
import { UrlBuilder } from '@innova2/url-builder'
import Swal from 'sweetalert2'
import { can } from '~/composables/useAuth'
import { useGeneralStore } from '~/store/generalStore'
import { useSelection } from '~/composables/useSelection'
import { bulkArchive, bulkUnarchive, bulkSoftDelete } from '~/services/listings/bulkActions'
import { useConfirm } from '~/composables/useConfirm'

useHead({
  title: 'Listings | Housinginteractive.com.ph',
})

const router = useRouter()

const { listings, pushListing, clearListings } = useListingsRawAtom()
const {
  listingColumnsData,
  buildColumns,
  destroyListings,
  clearListingsColumns,
} = useListingColumnsAtom()

// URL-synced filters: ?category, ?q, ?searchColumn. Defaults are kept out
// of the URL so shared links stay clean. Mutating any of these refs writes
// to the URL; landing on a URL with these params rehydrates the refs.
const currentCategory = useUrlState<'residential' | 'commercial'>('category', 'residential')
const currentSearchString = useUrlState<string>('q', '')
const currentSearchColumn = useUrlState<string>('searchColumn', '')

// pagination indicator
const currentPageRef = ref(1)
const pageItemsCountRef = ref(10) // Increased from 5 to 10

// Phase-1 in-page error state. Populated when getListings()/applyFilters()
// hit a fatal error so we can render <ListingsErrorState> with retry,
// instead of forcing a Swal modal + full page reload (which used to
// drop the URL-synced filters).
const listingsLoadError = ref<string | null>(null)
const isRetrying = ref(false)

// Phase-2 bulk-selection state. Selection persists across pagination
// (the underlying Set is not cleared when displayed rows change). It IS
// cleared after a successful bulk action and on filter / category change
// so the user doesn't accidentally archive rows from a previous query.
const selection = useSelection<number>()
const isBulkBusy = ref(false)
const confirmDialog = useConfirm()

// Listing change-history drawer state. listing-id = null hides the
// drawer; setting it triggers the in-component fetch via watcher.
const historyDrawerOpen = ref(false)
const historyDrawerListingId = ref<number | null>(null)
function openHistoryDrawer(id: number) {
  if (!Number.isFinite(id)) return
  historyDrawerListingId.value = id
  historyDrawerOpen.value = true
}
function closeHistoryDrawer() {
  historyDrawerOpen.value = false
}

async function bulkExecute(
  op: (ids: number[]) => Promise<{ ok: unknown[]; failed: Array<{ id: number; error: string }> }>,
  verb: string,
  pastTense: string,
  destructive = false,
) {
  if (selection.isEmpty.value) return

  const ids = selection.asArray()
  const confirmed = await confirmDialog.confirm({
    title: `${verb} ${ids.length} listing${ids.length === 1 ? '' : 's'}?`,
    description: destructive
      ? 'This action cannot be undone.'
      : `This will ${verb.toLowerCase()} every selected listing. You can undo by re-running the opposite action.`,
    confirmText: verb,
    cancelText: 'Cancel',
    variant: destructive ? 'destructive' : 'default',
  })
  if (!confirmed) return

  isBulkBusy.value = true
  try {
    const { ok, failed } = await op(ids)
    if (failed.length === 0) {
      showToast({
        title: `${ok.length} listing${ok.length === 1 ? '' : 's'} ${pastTense}`,
        icon: 'success',
      })
    } else {
      showToast({
        title: `${ok.length} ${pastTense}, ${failed.length} failed`,
        message: failed
          .slice(0, 3)
          .map((f) => `#${f.id}: ${f.error}`)
          .join('\n'),
        icon: 'warning',
        duration: 6000,
      })
    }
    selection.clear()
    await getListings()
  } finally {
    isBulkBusy.value = false
  }
}

const handleBulkArchive = () => bulkExecute(bulkArchive, 'Archive', 'archived')
const handleBulkUnarchive = () => bulkExecute(bulkUnarchive, 'Unarchive', 'unarchived')
const handleBulkSoftDelete = () => bulkExecute(bulkSoftDelete, 'Delete', 'deleted', true)

// New pagination state
const paginationState = reactive({
  total: 0,
  totalPages: 0,
  currentPage: 1,
  pageSize: 10,
  isLoading: false
})

type ListingColumns = InferType<typeof ListingColumnsSchema>
const filteredListingColumns = reactive({
  data: listingColumnsData,
  currentPage: 1,
  itemsPerPage: 10, // Increased from 5 to 10
})

// True when the listings page is in the day-1 empty state — no
// rows AND no active filters/search. Drives both the empty-state
// card AND the cards/table gate (so neither view tries to render
// rows that don't exist). Extracted into a computed so the same
// expression doesn't get type-checked twice (duplicating produced
// a TS2367 "no overlap" error on the legacy availability type).
const isInDayOneEmptyState = computed(
  () =>
    fetchListingsEnded.value &&
    paginationState.total === 0 &&
    !currentSearchString.value &&
    !currentSearchColumn.value &&
    String(currentAvailabilityType.value) === 'all',
)

// View mode: cards (default) vs. table (legacy power-user view).
// The legacy ListingsTable.vue uses viewport-relative column widths
// that overflow narrow viewports — cards fit any viewport and surface
// the same operational data inline. Operators who prefer the table
// (column-dense scan) can toggle via the segmented control.
// localStorage persists the choice across sessions.
type ListingsView = 'cards' | 'table'
const listingsView = ref<ListingsView>('cards')
const LISTINGS_VIEW_KEY = 'hi:listings:view'
onMounted(() => {
  if (typeof window === 'undefined') return
  try {
    const saved = localStorage.getItem(LISTINGS_VIEW_KEY)
    if (saved === 'cards' || saved === 'table') {
      listingsView.value = saved
    }
  } catch { /* SSR or denied storage — keep default */ }
})
watch(listingsView, (next) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LISTINGS_VIEW_KEY, next) } catch { /* ignore quota */ }
})

// Use listingShowingType from general store instead of local ref
const generalStore = useGeneralStore()

// Computed property for paginated data
const paginatedListings = ref([])

// Client-side "with / without photo" filter applied AFTER paging.
// Sourced from listing_data.has_photo (added in store/index.ts:188 —
// derived from listing_details MV's image_name column). 'all' bypasses
// the filter entirely. Default 'all' so existing operators see the
// same listings on first paint.
type PhotoFilter = 'all' | 'with' | 'without'
const photoFilter = ref<PhotoFilter>('all')
const displayListings = computed(() => {
  if (photoFilter.value === 'all') return paginatedListings.value
  return paginatedListings.value.filter((row: any) => {
    const hasPhoto = !!row?.listing_data?.has_photo
    return photoFilter.value === 'with' ? hasPhoto : !hasPhoto
  })
})

// Calculate total pages based on actual data length
const totalPages = computed(() => {
  return paginationState.totalPages || Math.ceil(listingColumnsData.length / pageItemsCountRef.value) || 1
})

// Computed property for page numbers to display
const displayedPageNumbers = computed(() => {
  const total = paginationState.totalPages
  const current = currentPageRef.value
  const pages = []
  
  if (total <= 7) {
    // If 7 or fewer pages, show all
    for (let i = 1; i <= total; i++) {
      pages.push(i)
    }
  } else {
    // Always show first page
    pages.push(1)
    
    // Determine the range of pages to show
    let startPage, endPage
    
    if (current <= 3) {
      // Near the beginning: show 1, 2, 3, 4, ..., last
      startPage = 2
      endPage = 4
    } else if (current >= total - 2) {
      // Near the end: show 1, ..., last-3, last-2, last-1, last
      startPage = total - 3
      endPage = total
    } else {
      // In the middle: show 1, ..., current-1, current, current+1, ..., last
      startPage = current - 1
      endPage = current + 1
    }
    
    // Add ellipsis after first page if needed
    if (startPage > 2) {
      pages.push('...')
    }
    
    // Add the middle pages
    for (let i = startPage; i <= endPage; i++) {
      if (i > 1 && i < total) {
        pages.push(i)
      }
    }
    
    // Add ellipsis before last page if needed
    if (endPage < total - 1) {
      pages.push('...')
    }
    
    // Always show last page if not already included
    if (total > 1) {
      pages.push(total)
    }
  }
  
  return pages
})

// Watch for data changes to reset pagination
watch(
  currentPageRef,
  () => {
    console.log('currentPageRef: ', currentPageRef.value)
  },
  { deep: true }
)

watch(
  paginatedListings,
  () => {
    console.log('paginatedListings: ', paginatedListings.value)
  },
  { deep: true }
)

const handlePageChange = async (page: number) => {
  console.log('page: ', page)
  console.log('totalPages: ', totalPages.value)
  if (page > 0 && page <= totalPages.value) {
    currentPageRef.value = page
    paginationState.currentPage = page

    // Display data from the pre-fetched and sorted allListingsData
    await fetchListingsForPage(page)
  }
}

const fetchListingsForPage = async (page: number) => {
  paginationState.isLoading = true
  showLoading()

  try {
    if (page > 0 && page <= paginationState.totalPages) {
      paginationState.currentPage = page
      currentPageRef.value = page
      await displayPageData(page)
    }
  } catch (error) {
    console.error('Error in fetchListingsForPage:', error)
    showToast({
      title: 'Error fetching listings',
      icon: 'error',
    })
  } finally {
    paginationState.isLoading = false
    dismissLoading()
  }
}

const handleDataProcessed = (processedData: any[]) => {
  // Reset to first page when data changes
  if (
    JSON.stringify(filteredListingColumns.data) !==
    JSON.stringify(processedData)
  ) {
    filteredListingColumns.currentPage = 1
    filteredListingColumns.data = processedData
  }
}

const FiltersSchema = yup.object({
  category: yup.string().nullable(),
  condition: yup.string().nullable(),
  type: yup.string().nullable(),
  forId: yup.string().nullable(),
  typeId: yup.string().nullable(),
  conditionId: yup.string().nullable(),
  availabilityFrom: yup.string().nullable(),
  availabilityTo: yup.string().nullable(),
  location: yup.string().nullable(),
  parking: yup.number().nullable(),
  minBedroom: yup.number().nullable(),
  maxBedroom: yup.number().nullable(),
  minBathroom: yup.number().nullable(),
  maxBathroom: yup.number().nullable(),
  minPrice: yup.number().nullable(),
  maxPrice: yup.number().nullable(),
  minPps: yup.number().nullable(),
  maxPps: yup.number().nullable(),
  minFloorArea: yup.number().nullable(),
  maxFloorArea: yup.number().nullable(),
  minLotArea: yup.number().nullable(),
  maxLotArea: yup.number().nullable(),
})

type AppliedFilters = InferType<typeof FiltersSchema>
const appliedFilters = reactive<AppliedFilters>({})

// Sync the AdvanceFilters fields to URL params so users can bookmark/share
// "available 3BR Makati under 5M" style links. Each field round-trips:
// reactive → ?param ; ?param → reactive on mount and on back/forward.
useReactiveUrlSync(appliedFilters, {
  forId: 'string',
  typeId: 'string',
  conditionId: 'string',
  availabilityFrom: 'string',
  availabilityTo: 'string',
  parking: 'number',
  minBedroom: 'number',
  maxBedroom: 'number',
  minBathroom: 'number',
  maxBathroom: 'number',
  minPrice: 'number',
  maxPrice: 'number',
  minPps: 'number',
  maxPps: 'number',
  minFloorArea: 'number',
  maxFloorArea: 'number',
  minLotArea: 'number',
  maxLotArea: 'number',
})

const availableFilters = reactive({
  fors: [],
  types: [],
  conditions: [],
  cities: [],
  barangays: [],
  forId: null,
  typeId: null,
  conditionId: null,
  parking: null,
  location: null,
  availabilityFrom: null,
  availabilityTo: null,
  minBedroom: null,
  maxBedroom: null,
  minBathroom: null,
  maxBathroom: null,
  minPrice: null,
  maxPrice: null,
  minPps: null,
  maxPps: null,
  minFloorArea: null,
  maxFloorArea: null,
  minLotArea: null,
  maxLotArea: null,
})

// Refs for modals
const listingModal = ref(null)
const listingCloneModal = ref(null)
const listingRemarksModal = ref(null)
const imageDownloadModal = ref(null)
const contactValidation = ref(null)
const contactInfoModal = ref(null)
const listingQuickUpdateModal = ref(null)
const logListModal = ref(null)
const logFormModal = ref(null)
const galleryModal = ref(null)
const settingsModal = ref(null)
const generateReportModal = ref(null)

// State refs
const startDownload = ref(false)
const updateListingId = ref(null)
const cloneListing = ref(null)
const selectedListing = ref(null)
const selectedListingIndex = ref(null)
const modalTitle = ref('')
const table = ref({})
const optionSelections = ref({})
const contactInformation = ref({})
const selectedListingForGenerateReport = ref([])
const contactDesignation = ref(null)
const checkboxData = ref([])
const sortedContactDesignationName = ref(null)
const imagesType = ref(0)
const autoShowAddForm = ref(false)

// Display Status filter
const displayStatusFilter = ref('all')

const contactData = ref({
  full_name: null,
  designation: null,
  home_phone: null,
  mobile_phone: null,
  email: null,
  link: null,
  notes: null,
})

const listingsUrlParams = ref({
  searchColumn: 'id',
  division: 1,
  page: null,
  search: null,
  designation: null,
  isOnline: null,
  category: null,
  type: null,
  condition: null,
  availability: null,
  availabilityTo: null,
  user: null,
  city: null,
  location: null,
  parking: null,
  priceMin: null,
  priceMax: null,
  priceSqmMin: null,
  priceSqmMax: null,
  floorAreaMin: null,
  floorAreaMax: null,
  lotAreaMin: null,
  lotAreaMax: null,
  bedroomMin: null,
  bedroomMax: null,
  bathroomMin: null,
  bathroomMax: null,
  minBathroom: null,
  maxBathroom: null,
  minBedroom: null,
  maxBedroom: null,
  suggestionModel: null,
  orderBy: 'id',
  order: 'desc',
})

const updateStatusModal = ref(null)
const currentListingForAvailabilityUpdate = ref(null)

const listingsRaw = ref([])

const afterFetch = () => {
  if (autoShowAddForm.value) {
    addListing()
    autoShowAddForm.value = false
  }
}

// URL-synced: ?availability=active|archived is the source of truth.
// Updating the ref updates the URL; landing on a URL with this param
// rehydrates the ref. Default value is omitted from the URL so shared
// links stay clean.
const currentAvailabilityType = useUrlState<'active' | 'archived'>('availability', 'active')

async function changeAvailabilityType(type: 'active' | 'archived') {
  currentAvailabilityType.value = type
  await getListings()
}

function sortByPrice(order: 'low-to-high' | 'high-to-low') {
  console.log('Sorting by price:', order)
  
  // Sort the paginatedListings array directly
  paginatedListings.value.sort((a, b) => {
    // Get price values - prioritize sale_price, fall back to rent_price
    const priceA = a.price?.sale_price || a.price?.rent_price || 0
    const priceB = b.price?.sale_price || b.price?.rent_price || 0
    
    if (order === 'low-to-high') {
      return priceA - priceB
    } else {
      return priceB - priceA
    }
  })
  
  // Also sort listingColumnsData to keep them in sync
  listingColumnsData.sort((a, b) => {
    const priceA = a.price?.sale_price || a.price?.rent_price || 0
    const priceB = b.price?.sale_price || b.price?.rent_price || 0
    
    if (order === 'low-to-high') {
      return priceA - priceB
    } else {
      return priceB - priceA
    }
  })
  
  console.log('Sorted data:', paginatedListings.value.slice(0, 5))
}

async function updateListingStatusInstant(listingId: number, newStatus: any) {
  const nuxtApp = useNuxtApp()
  const { data, error } = await useSupabaseClient()
    .from('listings')
    .update({ status: newStatus.value })
    .eq('id', listingId)
    .select()

  if (error) {
    console.error('Error updating status:', error)
  }

  if (data) {
    //update status locally
    const listing = listingColumnsData.find(
      (listing) => listing.listing_data.listing_id === listingId
    )
    listing.status.value = newStatus.value
    listing.status.label = newStatus.label

    //deploy update localStorage value
    localStorage.setItem(`tempListing-${listingId}`, JSON.stringify(listing))

    //show toast
    showToast({
      title: 'Status updated successfully',
      icon: 'success',
    })
  } else {
    //show toast
    showToast({
      title: 'Error updating status',
      icon: 'error',
    })
  }
}

async function triggerStatusSwitch(listingId: number) {
  if (generalStore.listingShowingType === 'personal') {
    console.log('triggerStatusSwitch called for listing:', listingId)
  } else if (!can('edit_any_listing')) {
    console.log('triggerStatusSwitch called for listing:', listingId)
    showToast({
      title: 'You don\'t have permission to update status',
      icon: 'error',
    })
    return
  }

  console.log('triggerStatusSwitch called for listing:', listingId)

  // Find the listing in the data to get current status and title
  const listing = listingColumnsData.find(
    (listing) => listing.listing_data.listing_id === listingId
  )

  if (listing) {
    const statusMapping = {
      'available': 'AVAILABLE',
      'occupied-rented': 'TENANTED',
      'on-hold': 'ON HOLD',
      'under-negotiation': 'UNDER NEGOTIATION',
      'sold': 'SOLD'
    }

    const currentStatus = listing.status?.value || 'AVAILABLE'
    const mappedStatus = statusMapping[currentStatus] || currentStatus
    const title = listing.listing_data.title || `Listing ${listingId}`

    await showUpdateStatusModal(listingId, title, mappedStatus)
  } else {
    console.error('Listing not found:', listingId)
  }
}

async function triggerListingEnablement(listingId: number) {
  if (!can('edit_any_listing')) {
    console.log('triggerListingEnablement called for listing:', listingId)
    showToast({
      title: 'You do not have permission to enable/disable listings',
      icon: 'error',
    })
    return
  }

  ;(async () => {
    const { confirm } = useConfirm()
    const ok = await confirm({
      title: 'Switch listing status?',
      description: `Are you sure you want to switch status of listing ${listingId}?`,
      confirmText: 'Confirm',
      variant: 'destructive',
    })
    if (ok) {
      showLoading()
      const nuxtApp = useNuxtApp()

      const listing_is_online = listingColumnsData.find(
        (listing) => listing.listing_data.listing_id === listingId
      )?.is_online.value

      console.log('Switching status for listing:', listingId, 'Current status:', listing_is_online)

      const { data, error } = await useSupabaseClient()
        .from('listings')
        .update({ is_online: !listing_is_online, updated_at: new Date() })
        .eq('id', listingId)
        .select()



      if (error) {
        console.error('Error switching status:', error)
        showSwal({
          title: 'Error',
          html: 'Error switching status. Please try again.',
          icon: 'error',
          allowOutsideClick: false,
        })
        dismissLoading()
        return
      }

      if (data) {
        console.log("switching status to ~ data: ", data)
        // Update localStorage immediately
        const updateData = {
          ...data[0],
          is_online: !listing_is_online,
          listing_id: listingId,
          for: 'update',
        }

        // Store in localStorage and trigger update
        localStorage.setItem(
          `tempListing-${listingId}`,
          JSON.stringify(updateData)
        )

        // Dispatch a custom event to notify about the update
        window.dispatchEvent(new CustomEvent('listing-updated', {
          detail: { listingId, updates: updateData }
        }))

        showToast({
          title: 'Status switched successfully',
          icon: 'success',
        })
      }

      dismissLoading()
    }
  })()
}

// - [ x ] 1. fetch listing_details
async function fetchListingDetails(listingsShowingType) {
  console.log('Step 1: fetchListingDetails')
  clearListingsColumns()
  clearListings()

  const listingsData =
    listingsShowingType === 'personal'
      ? await ListingService._getListings()
      : await ListingService._getOtherBrokerListings()

  return listingsData
}

// - [ x ] 2. check for existing local storage keys for (newly added, deleted, updated)
function checkForExistingLocalStorageKeys() {
  console.log('Step 2: checkForExistingLocalStorageKeys')
  const existingKeys = Object.keys(localStorage)
    .filter((key) => key.startsWith('tempListing-'))
    .map((key) => ({
      key,
      value: localStorage.getItem(key),
    }))

  console.log('existingKeys: ', existingKeys)

  return existingKeys
}

// - [ x ] 3. complete correct operations for each key
async function completeCorrectOperationsForEachKey(listingsData) {
  console.log('Step 3: completeCorrectOperationsForEachKey')
  let currentListings = listingsData ? listingsData : { data: [] }
  const existingKeys = checkForExistingLocalStorageKeys()
  const user = useSupabaseUser()

  for (const key of existingKeys) {
    const keyListing = JSON.parse(key.value)
    console.log('Processing keyListing:', keyListing)

    // Check if this localStorage operation is relevant to the current viewing type
    let isRelevantToCurrentView = false

    if (keyListing.listing_id) {
      // Find the listing in the current data to check its created_by field
      const existingListing = currentListings.data.find(listing => listing.listing_id === keyListing.listing_id)

      if (generalStore.listingShowingType === 'personal') {
        // For personal view, only apply operations to listings created by the current user
        isRelevantToCurrentView = existingListing ? existingListing.created_by === user.value?.id :
          (keyListing.created_by === user.value?.id)
      } else {
        // For broker view, only apply operations to listings NOT created by the current user
        isRelevantToCurrentView = existingListing ? existingListing.created_by !== user.value?.id :
          (keyListing.created_by !== user.value?.id)
      }
    } else {
      // For new listings (creation), check if they belong to the current viewing type
      if (generalStore.listingShowingType === 'personal') {
        isRelevantToCurrentView = keyListing.created_by === user.value?.id
      } else {
        isRelevantToCurrentView = keyListing.created_by !== user.value?.id
      }
    }

    // Skip this operation if it's not relevant to the current viewing type
    if (!isRelevantToCurrentView) {
      console.log('Skipping localStorage operation - not relevant to current viewing type:', keyListing)
      continue
    }

    if (keyListing.for === 'creation') {
      if (!currentListings.data.find(listing => listing.listing_id === keyListing.listing_id)) {
        currentListings.data.push(keyListing)
        // Keep the localStorage key for newly created items until they're saved to the server
      } else {
        // Remove the localStorage key if the item already exists in the data
        localStorage.removeItem(key.key)
      }
    } else if (keyListing.for === 'deletion') {
      console.log('Processing deletion for listing:', keyListing.listing_id)
      const foundListing = currentListings.data.find(listing => listing.listing_id === keyListing.listing_id)
      if (foundListing) {
        console.log('Found listing to delete, removing from data and localStorage')
        currentListings.data = currentListings.data.filter(
          listing => listing.listing_id !== keyListing.listing_id
        )
        // Remove the localStorage key after successful deletion
        localStorage.removeItem(key.key)
        console.log('Deleted listing and removed from localStorage')
      } else {
        console.log('Listing not found in data, removing from localStorage only')
        localStorage.removeItem(key.key)
      }
    } else if (keyListing.for === 'update') {
      const index = currentListings.data.findIndex(
        listing => listing.listing_id === keyListing.listing_id
      )

      if (index !== -1) {
        // Merge the updated fields from keyListing with the existing listing.
        // Preserve the joined relations (contact / city / barangay) — the
        // merge incoming from a temp listing only carries scalar updates and
        // shouldn't blow away the relational shape we render from. The
        // legacy *_name keys are kept here too for the transition window;
        // they'll fall away once Phase E/F drops the columns.
        const existingListing = currentListings.data[index]
        currentListings.data[index] = {
          ...existingListing,
          ...keyListing,
          contact: existingListing.contact,
          city: existingListing.city,
          barangay: existingListing.barangay,
          contact_name: existingListing.contact_name,
          contact_designation: existingListing.contact_designation,
          contact_email: existingListing.contact_email,
          contact_home_phone: existingListing.contact_home_phone,
          contact_mobile_number: existingListing.contact_mobile_number,
          city_name: existingListing.city_name,
          city_slug: existingListing.city_slug,
          property_category: existingListing.property_category,
        }

        // Dispatch update event for immediate UI update
        window.dispatchEvent(new CustomEvent('listing-updated', {
          detail: {
            listingId: keyListing.listing_id,
            updates: keyListing
          }
        }))

        // Remove the localStorage key after successful update
        localStorage.removeItem(key.key)
      } else {
        localStorage.removeItem(key.key)
      }
    }
  }

  return currentListings
}

// - [ x ] 4. update local storage
// function updateLocalStorage(listingsData) {
//   const existingKeys = checkForExistingLocalStorageKeys()
//   //delete all existing keys
//   existingKeys.forEach((key) => {
//     localStorage.removeItem(key)
//   })
//   //add new keys
//   listingsData.forEach((listing) => {
//     localStorage.setItem(listing.id, JSON.stringify(listing))
//   })
// }

// - [ ] 5. build displayedListingColumns
async function buildDisplayedListingColumns(listingsShowingType) {
  console.log('Step 5: buildDisplayedListingColumns')
  
  // Fetch listings with proper sorting by ID descending (most recent first)
  let listingsData
  if (generalStore.listingShowingType === 'personal') {
    const result = await ListingService._getPaginatedListings(1, 10000, { orderBy: 'id', order: 'desc' })
    listingsData = { ...result, data: result.data || [] }
  } else {
    const result = await ListingService._getOtherBrokerListingsPaginated(1, 10000, { orderBy: 'id', order: 'desc' })
    listingsData = { ...result, data: result.data || [] }
  }
  
  listingsRaw.value = listingsData.data

  const currentListings = await completeCorrectOperationsForEachKey(
    listingsData
  )

  console.log('currentListings: ', currentListings)

  // Re-sort after localStorage operations to maintain chronological order
  if (currentListings.data && currentListings.data.length > 0) {
    currentListings.data.sort((a, b) => (b.listing_id || b.id) - (a.listing_id || a.id))
  }

  if (currentListings.data) {
    for (const listing of currentListings.data) {
      await buildColumns(listing, true) // Skip localStorage check since it's already handled
    }
  }

  console.log('listingColumnsData: ', listingColumnsData)
}

// Store all fetched listings for client-side pagination
const allListingsData = ref<any[]>([])

const getListings = async () => {
  showLoading()
  fetchListingsEnded.value = false
  allListingsData.value = []  // Reset data

  try {
    const filters = {
      division: currentCategory.value,
      isOnline: displayStatusFilter.value !== 'all' ? displayStatusFilter.value : null,
      orderBy: 'id',
      order: 'desc'
    }

    // Fetch first batch (1000 items) - this shows up immediately
    let result
    if (generalStore.listingShowingType === 'personal') {
      result = await ListingService._getPaginatedListings(1, 1000, filters)
    } else {
      result = await ListingService._getOtherBrokerListingsPaginated(1, 1000, filters)
    }

    if (result.error || !result.data) {
      // Surface inline so the user keeps their filters / URL state — the
      // previous Swal+reload flow erased everything in the URL on retry.
      listingsLoadError.value = typeof result.error === 'string'
        ? result.error
        : 'We could not load your listings. Please try again.'
      dismissLoading()
      return
    }
    // Clear any prior error on a successful refetch.
    listingsLoadError.value = null

    // Sort first batch
    let sortedData = result.data.sort((a, b) => (b.listing_id || b.id) - (a.listing_id || a.id))

    console.log('First batch fetched, count:', sortedData.length)
    console.log('First 10 IDs:', sortedData.slice(0, 10).map(d => d.listing_id || d.id))

    // Store for pagination
    allListingsData.value = sortedData

    // PostgREST `count: 'exact'` has been observed returning an inflated
    // value (likely an ambiguous-id issue on the listing_details view post
    // listing_id->id rename). Guard the pagination logic: if the first batch
    // came back with fewer rows than the requested page size, we already have
    // everything — trust the actual data length, not result.total.
    const FIRST_BATCH_SIZE = 1000
    const firstBatchFull = sortedData.length >= FIRST_BATCH_SIZE
    const knownTotal = firstBatchFull ? result.total : sortedData.length
    const totalBatches = firstBatchFull ? result.totalPages : 1

    // Update pagination state
    paginationState.total = knownTotal
    paginationState.totalPages = Math.ceil(knownTotal / (pageItemsCountRef.value || 10))

    // Clear and rebuild columns for first page
    clearListingsColumns()
    clearListings()

    // Process first batch with localStorage operations
    const currentListings = await completeCorrectOperationsForEachKey({
      data: sortedData
    })

    // Re-sort after localStorage operations
    if (currentListings.data && currentListings.data.length > 0) {
      currentListings.data.sort((a, b) => (b.listing_id || b.id) - (a.listing_id || a.id))
      allListingsData.value = currentListings.data
    }

    console.log('After localStorage integration, total listings:', allListingsData.value.length)

    // Build columns for first page
    await displayPageData(1)

    // Generate available filters after first batch is loaded
    await generateAvailableFilters()

    // Fetch remaining batches in background without blocking (non-blocking)
    if (totalBatches > 1) {
      console.log(`Fetching remaining ${totalBatches - 1} batches in background...`)
      fetchRemainingBatches(filters, totalBatches)
    }

  } catch (error) {
    console.error('Error in getListings:', error)
    listingsLoadError.value = error instanceof Error
      ? error.message
      : 'We could not load your listings. Please try again.'
  } finally {
    dismissLoading()
    fetchListingsEnded.value = true

    if (listings) {
      afterFetch()
    }
  }
}

// Retry handler exposed to <ListingsErrorState>. Sets the retrying flag so
// the button shows a "Retrying…" spinner state, then re-runs getListings.
async function retryGetListings() {
  isRetrying.value = true
  try {
    await getListings()
  } finally {
    isRetrying.value = false
  }
}

// Fetch remaining batches in background without blocking. Defensive stop
// conditions prevent runaway loops when the first batch's `totalPages`
// doesn't match reality — e.g. a stale count, a server-side filter mismatch,
// or PostgREST returning 416 once offset exceeds the actual row count.
const fetchRemainingBatches = async (filters: any, totalBatches: number) => {
  try {
    for (let pageNum = 2; pageNum <= totalBatches; pageNum++) {
      console.log(`Background: Fetching batch ${pageNum}/${totalBatches}...`)

      let result
      if (generalStore.listingShowingType === 'personal') {
        result = await ListingService._getPaginatedListings(pageNum, 1000, filters)
      } else {
        result = await ListingService._getOtherBrokerListingsPaginated(pageNum, 1000, filters)
      }

      // Stop on error (PGRST103, network failure, etc.) — the next pages will
      // fail the same way, no point spamming the server.
      if (result.error) {
        console.warn(`Batch ${pageNum} stopped on error; aborting background fetch.`, result.error)
        break
      }

      // Empty data means we've drained whatever the server actually has,
      // regardless of what totalBatches claimed.
      if (!result.data || result.data.length === 0) {
        console.log(`Batch ${pageNum} returned empty; aborting background fetch.`)
        break
      }

      // Sort before appending
      result.data.sort((a: any, b: any) => (b.listing_id || b.id) - (a.listing_id || a.id))
      allListingsData.value.push(...result.data)
      console.log(`Batch ${pageNum} appended, total now: ${allListingsData.value.length}`)

      // Small delay between batches to avoid overwhelming backend
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    console.log('All batches fetched and cached')
  } catch (error) {
    console.warn('Error fetching remaining batches:', error)
    // Don't fail - we already have first batch loaded
  }
}

// New function to display paginated data from allListingsData
const displayPageData = async (pageNum: number) => {
  const pageSize = pageItemsCountRef.value || 10
  const startIndex = (pageNum - 1) * pageSize
  const endIndex = startIndex + pageSize
  
  // Get the items for this page from the complete sorted list
  const pageData = allListingsData.value.slice(startIndex, endIndex)
  
  console.log(`=== DISPLAYING PAGE ${pageNum} ===`)
  console.log('Page data IDs:', pageData.map(d => d.listing_id || d.id))
  
  // Clear and rebuild columns for this specific page
  clearListingsColumns()
  clearListings()
  
  // Build columns for the page data
  for (const listing of pageData) {
    await buildColumns(listing, true)
  }
  
  // Update paginated listings
  paginatedListings.value = [...listingColumnsData] as any[]
  
  console.log('Updated paginatedListings - IDs:', paginatedListings.value.map(d => d.listing_data.listing_id))
  console.log(`=== PAGE ${pageNum} DISPLAY COMPLETE ===`)
}

const addListing = () => {
  // Modal-based create flow was crashing in production with a TDZ;
  // create now lives at /listings/new. The local Modal block in this
  // template is unreachable but kept until Phase 6 cleanup.
  router.push('/listings/new')
}

const closeListingModal = async () => {
  console.log('Closing listing modal')
  listingModal.value?.toggleModal()
  document.getElementById('overlay')?.remove()
  await getListings()
}

const showLogForm = (listingId) => {
  selectedListingId.value = listingId
  logFormModal.value?.toggleModal()
}

const closeLogFormModal = () => {
  selectedListingId.value = null
  logFormModal.value?.toggleModal()
}

const sortContactDesignation = (listing) => {
  listingsUrlParams.value.designation = listing.user_designation_id
  sortedContactDesignationName.value = listing.user_designation
  contactDesignation.value = listing.user_designation_id
  getListings()
}

const addListingFromGenerateReport = (listing) => {
  selectedListingForGenerateReport.value.push(listing)
  checkboxData.value.push(listing.id)
}

const removeListingFromGenerateReport = (id) => {
  selectedListingForGenerateReport.value =
    selectedListingForGenerateReport.value.filter((l) => l.id !== id)
  removeCheckBox(id)
}

const removeCheckBox = (id) => {
  checkboxData.value = checkboxData.value.filter(
    (listingId) => listingId !== id
  )
}

const updateAvailabilityModal = ref(null)
const newTemporaryAvailability = ref(null)

const checkIfAvailabilityIsChanged = () => {
  return newTemporaryAvailability.value !== currentListingForAvailabilityUpdate.value.availability
}

const updateAvailability = async () => {
  const nuxtApp = useNuxtApp()
  const { data, error } = await useSupabaseClient()
    .from('listings')
    .update({ availability_date: newTemporaryAvailability.value })
    .eq('id', currentListingForAvailabilityUpdate.value!.listing_id)
    .select()

  if (error) {
    console.error('Error updating availability:', error)
    showSwal({
      title: 'Error',
      html: 'Error updating availability',
      icon: 'error',
    })
    return
  }

  if (data) {
    const listingId = currentListingForAvailabilityUpdate.value!.listing_id
    const updateData = {
      ...data[0],
      availability_date: newTemporaryAvailability.value,
      listing_id: listingId,
      for: 'update',
    }

    // Store in localStorage and trigger update
    localStorage.setItem(
      `tempListing-${listingId}`,
      JSON.stringify(updateData)
    )

    // Dispatch a custom event to notify about the update
    window.dispatchEvent(new CustomEvent('listing-updated', {
      detail: { listingId, updates: updateData }
    }))

    showToast({
      title: 'Availability updated successfully',
      icon: 'success',
    })

    // Close the modal
    updateAvailabilityModal.value?.toggleModal()
  }
}

// Add status-related refs and functions
const newTemporaryStatus = ref(null)

const checkIfStatusIsChanged = () => {
  return newTemporaryStatus.value !== currentListingForAvailabilityUpdate.value?.status
}

const updateStatus = async () => {
  const nuxtApp = useNuxtApp()
  const { data, error } = await useSupabaseClient()
    .from('listings')
    .update({ status: newTemporaryStatus.value })
    .eq('id', currentListingForAvailabilityUpdate.value!.listing_id)
    .select()

  if (error) {
    console.error('Error updating status:', error)
    showSwal({
      title: 'Error',
      html: 'Error updating status',
      icon: 'error',
    })
    return
  }

  if (data) {
    const listingId = currentListingForAvailabilityUpdate.value!.listing_id
    const updateData = {
      ...data[0],
      status: newTemporaryStatus.value,
      listing_id: listingId,
      for: 'update',
    }

    // Store in localStorage and trigger update
    localStorage.setItem(
      `tempListing-${listingId}`,
      JSON.stringify(updateData)
    )

    // Dispatch a custom event to notify about the update
    window.dispatchEvent(new CustomEvent('listing-updated', {
      detail: { listingId, updates: updateData }
    }))

    showToast({
      title: 'Status updated successfully',
      icon: 'success',
    })

    // Close the modal
    updateStatusModal.value?.toggleModal()
  }
}

const showUpdateAvailabilityModal = async (listingId, title, availability) => {
  if (generalStore.listingShowingType === 'personal') {
    console.log('showUpdateAvailabilityModal called for listing:', listingId)
  } else if (!can('edit_any_listing')) {
    console.log('showUpdateAvailabilityModal called for listing:', listingId)
    showToast({
      title: 'You don\'t have permission to update availability',
      icon: 'error',
    })
    return
  }

  console.log('listingId from showUpdateAvailabilityModal: ', listingId)
  console.log('title from showUpdateAvailabilityModal: ', title)
  console.log('availability from showUpdateAvailabilityModal: ', availability)
  currentListingForAvailabilityUpdate.value = {
    listing_id: listingId,
    title: title,
    availability: availability,
  }
  newTemporaryAvailability.value = availability
  updateAvailabilityModal.value?.toggleModal()
}

const showUpdateStatusModal = async (listingId, title, status) => {
  console.log('listingId from showUpdateStatusModal: ', listingId)
  console.log('title from showUpdateStatusModal: ', title)
  console.log('status from showUpdateStatusModal: ', status)
  currentListingForAvailabilityUpdate.value = {
    listing_id: listingId,
    title: title,
    status: status,
  }
  newTemporaryStatus.value = status
  updateStatusModal.value?.toggleModal()
}

const showContactInformationModal = async (id) => {
  console.log('showContactInformationModal called with ID:', id, 'Type:', typeof id)
  
  // Validate ID - check if null, undefined, or invalid
  if (!id || id === null || id === undefined) {
    console.warn('No contact ID provided')
    showToast({
      title: 'No contact information available',
      icon: 'info',
    })
    return
  }

  // Convert to number if string
  const contactId = typeof id === 'string' ? parseInt(id, 10) : id
  
  if (isNaN(contactId) || contactId < 1) {
    console.warn('Invalid contact ID:', id, 'Parsed as:', contactId)
    showToast({
      title: 'No contact information available',
      icon: 'info',
    })
    return
  }

  console.log('Fetching contact with ID:', contactId)
  const nuxtApp = useNuxtApp()
  const { data, error } = await useSupabaseClient()
    .from('contacts')
    .select('*')
    .eq('id', contactId)

  if (error) {
    console.error('Error fetching contact:', error)
    showToast({
      title: 'Error fetching contact information',
      icon: 'error',
    })
    return
  }

  console.log('Contact query result:', data)
  
  if (data && data.length > 0) {
    contactData.value = data[0]
    console.log('Contact data loaded successfully')
    contactInfoModal.value?.toggleModal()
  } else {
    console.warn('No contact found with ID:', contactId)
    showToast({
      title: 'Contact not found',
      icon: 'warning',
    })
  }
}

const afterCloneListing = () => {
  listingCloneModal.value?.toggleModal()
  setTimeout(() => {
    getListings()
  }, 1000)
}

const closeRemarksModal = (remarks) => {
  selectedListing.value.remarks = remarks
  listingRemarksModal.value?.toggleModal()
  showLogForm(selectedListing.value.id)
}

const closeQuickUpdateModal = (listing) => {
  // pass the listing to update data pass in Table component
  // this is to update the table row display
  selectedListing.value = listing
  table.value.data[selectedListingIndex.value] = listing
  listingQuickUpdateModal.value?.toggleModal()
  showLogForm(selectedListing.value.id)
}

const chooseImageType = (value) => {
  imagesType.value = value
}

const downloadAllImages = async (isPaid = 0) => {
  startDownload.value = true
  const zipLink = await $fetch(
    `/api/listings/${selectedListing.value.id}/download-images`,
    {
      method: 'GET',
      params: {
        isPaid,
      },
    }
  )
  window.open(zipLink.url)

  startDownload.value = false
  selectedListing.value = null
  imageDownloadModal.value?.toggleModal()
}

const userCanViewAllListings = computed(() => can('view_all_listings'))
async function checkQueryParams() {
  const urlBuilder = UrlBuilder.createFromUrl(window.location.href)

  const currentView = urlBuilder.getQueryParams().get('view')
  const currentDivision = urlBuilder.getQueryParams().get('division')
  const currentAvailability = urlBuilder.getQueryParams().get('availability')

  if (currentView === 'broker' && !userCanViewAllListings.value) {
    urlBuilder.getQueryParams().set('view', 'personal')
    generalStore.listingShowingType = 'personal'
  }

  if (!currentView) {
    urlBuilder.getQueryParams().set('view', 'personal')
    generalStore.listingShowingType = 'personal'
  }
  if (!currentDivision) {
    urlBuilder.getQueryParams().set('division', 'residential')
    currentCategory.value = 'residential'
  }

  if (!currentAvailability) {
    urlBuilder.getQueryParams().set('availability', 'all')
    currentAvailabilityType.value = 'all'
  }

  if (currentView) {
    generalStore.listingShowingType = currentView
  }

  if (currentDivision) {
    currentCategory.value = currentDivision
  }

  if (currentAvailability) {
    currentAvailabilityType.value = currentAvailability
  }

  // Process filter parameters from URL
  const minBedroom = urlBuilder.getQueryParams().get('minBedroom')
  const maxBedroom = urlBuilder.getQueryParams().get('maxBedroom')
  const minBathroom = urlBuilder.getQueryParams().get('minBathroom')
  const maxBathroom = urlBuilder.getQueryParams().get('maxBathroom')
  const minPrice = urlBuilder.getQueryParams().get('minPrice')
  const maxPrice = urlBuilder.getQueryParams().get('maxPrice')
  const minPps = urlBuilder.getQueryParams().get('minPps')
  const maxPps = urlBuilder.getQueryParams().get('maxPps')
  const minFloorArea = urlBuilder.getQueryParams().get('minFloorArea')
  const maxFloorArea = urlBuilder.getQueryParams().get('maxFloorArea')
  const minLotArea = urlBuilder.getQueryParams().get('minLotArea')
  const maxLotArea = urlBuilder.getQueryParams().get('maxLotArea')
  const parking = urlBuilder.getQueryParams().get('parking')
  const location = urlBuilder.getQueryParams().get('location')
  const availabilityFrom = urlBuilder.getQueryParams().get('availabilityFrom')
  const availabilityTo = urlBuilder.getQueryParams().get('availabilityTo')
  const forId = urlBuilder.getQueryParams().get('forId')
  const typeId = urlBuilder.getQueryParams().get('typeId')
  const conditionId = urlBuilder.getQueryParams().get('conditionId')

  // Populate availableFilters with URL parameters
  if (minBedroom) availableFilters.minBedroom = minBedroom
  if (maxBedroom) availableFilters.maxBedroom = maxBedroom
  if (minBathroom) availableFilters.minBathroom = minBathroom
  if (maxBathroom) availableFilters.maxBathroom = maxBathroom
  if (minPrice) availableFilters.minPrice = minPrice
  if (maxPrice) availableFilters.maxPrice = maxPrice
  if (minPps) availableFilters.minPps = minPps
  if (maxPps) availableFilters.maxPps = maxPps
  if (minFloorArea) availableFilters.minFloorArea = minFloorArea
  if (maxFloorArea) availableFilters.maxFloorArea = maxFloorArea
  if (minLotArea) availableFilters.minLotArea = minLotArea
  if (maxLotArea) availableFilters.maxLotArea = maxLotArea
  if (parking) availableFilters.parking = parking
  if (location) availableFilters.location = location
  if (availabilityFrom) availableFilters.availabilityFrom = availabilityFrom
  if (availabilityTo) availableFilters.availabilityTo = availabilityTo
  if (forId) availableFilters.forId = forId
  if (typeId) availableFilters.typeId = typeId
  if (conditionId) availableFilters.conditionId = conditionId

  console.log('currentAvailabilityType from checkQueryParams: ', currentAvailabilityType.value)

  // ?showform=add — legacy entry point. The "New listing" flow is now a
  // dedicated /listings/new page (the modal mount path was crashing in
  // production with a TDZ). Redirect any saved bookmarks / external links
  // to the new route. The autoShowAddForm watch path is kept as a no-op
  // for any in-flight references.
  if (urlBuilder.getQueryParams().get('showform') === 'add') {
    router.replace('/listings/new')
    return
  }

  window.history.pushState({}, '', urlBuilder.toString())
}
const selectedListingDetails = ref<ListingColumns>(null)
// Lifecycle hooks
onMounted(async () => {
  await checkQueryParams()

  // Initialize by fetching all listings and doing client-side pagination
  await getListings()

  console.log('availableFilters onMounted: ', availableFilters)

  // toggleListingDetailsSidebar(filteredData.data[0])
  // toggleTableViewOptionsSidebar()
})

// Auth-state catch-up. The first getListings() may run before the
// Supabase user/session ref hydrates (the service early-returns
// empty in that case). Re-fire once auth resolves so the table
// fills in without a manual refresh.
{
  const _user = useSupabaseUser()
  const stop = watch(_user, async (next, prev) => {
    if (next?.id && next.id !== prev?.id && allListingsData.value.length === 0) {
      await getListings()
    }
  })
  // Stop the watcher on unmount via Vue's onScopeDispose semantics —
  // the inline scope of <script setup> handles teardown for us.
  void stop
}

async function resetFilters() {
  // Drop bulk-selection so users don't accidentally archive rows that
  // came from a previous filter context.
  selection.clear()
  // Reset all filter values
  availableFilters.parking = null
  availableFilters.location = null
  availableFilters.forId = null
  availableFilters.typeId = null
  availableFilters.conditionId = null
  availableFilters.availabilityFrom = null
  availableFilters.availabilityTo = null
  availableFilters.minBedroom = null
  availableFilters.maxBedroom = null
  availableFilters.minBathroom = null
  availableFilters.maxBathroom = null
  availableFilters.minPrice = null
  availableFilters.maxPrice = null
  availableFilters.minPps = null
  availableFilters.maxPps = null
  availableFilters.minFloorArea = null
  availableFilters.maxFloorArea = null
  availableFilters.minLotArea = null
  availableFilters.maxLotArea = null

  // Reset to first page
  currentPageRef.value = 1
  paginationState.currentPage = 1

  // Reload all listings
  await getListings()

  showToast({
    title: 'Filters reset successfully',
    icon: 'success',
  })
}

onUnmounted(() => {
  console.log('onUnmounted')

  //free up memory
  filteredListingColumns.data = []
  destroyListings()
})

async function applyFilters() {
  // Reset to first page when applying filters
  currentPageRef.value = 1
  paginationState.currentPage = 1
  
  await getListings()
}

function resetAvailableFilters(filterToReset: string) {
  if (filterToReset === 'category') {
    availableFilters.categories.forEach(
      (category) => (category.selected = false)
    )
  } else if (filterToReset === 'type') {
    availableFilters.types.forEach((type) => (type.selected = false))
  } else if (filterToReset === 'condition') {
    availableFilters.conditions.forEach(
      (condition) => (condition.selected = false)
    )
  } else if (filterToReset === 'forId') {
    availableFilters.forId = null
  } else if (filterToReset === 'typeId') {
    availableFilters.typeId = null
  } else if (filterToReset === 'conditionId') {
    availableFilters.conditionId = null
  } else if (filterToReset === 'availabilityFrom') {
    availableFilters.availabilityFrom = null
  } else if (filterToReset === 'availabilityTo') {
    availableFilters.availabilityTo = null
  } else if (filterToReset === 'parking') {
    availableFilters.parking = null
  } else if (filterToReset === 'location') {
    availableFilters.location = null
  } else if (filterToReset === 'minBedroom') {
    availableFilters.minBedroom = null
  } else if (filterToReset === 'maxBedroom') {
    availableFilters.maxBedroom = null
  } else if (filterToReset === 'minBathroom') {
    availableFilters.minBathroom = null
  } else if (filterToReset === 'maxBathroom') {
    availableFilters.maxBathroom = null
  } else if (filterToReset === 'minPrice') {
    availableFilters.minPrice = null
  } else if (filterToReset === 'maxPrice') {
    availableFilters.maxPrice = null
  } else if (filterToReset === 'minPps') {
    availableFilters.minPps = null
  } else if (filterToReset === 'maxPps') {
    availableFilters.maxPps = null
  } else if (filterToReset === 'minFloorArea') {
    availableFilters.minFloorArea = null
  } else if (filterToReset === 'maxFloorArea') {
    availableFilters.maxFloorArea = null
  } else if (filterToReset === 'minLotArea') {
    availableFilters.minLotArea = null
  } else if (filterToReset === 'maxLotArea') {
    availableFilters.maxLotArea = null
  }
}

async function removeFilter(filter: string) {
  // Remove the filter from appliedFilters
  delete appliedFilters[filter]

  console.log('appliedFilters after removeFilter: ', appliedFilters)

  await resetAvailableFilters(filter)
  await applyFilters()
}

// Store the original unfiltered data
const originalListingColumnsData = ref([])
const isFiltering = ref(false)
const crossCategoryResults = ref({
  residential: 0,
  commercial: 0,
  hasCrossCategory: false
})

async function handleFilterTableData(filterData: { searchColumn: string; searchValue: string }) {
  console.log('handleFilterTableData:', filterData)

  isFiltering.value = true
  showLoading()

  try {
    // If search value is empty, clear the filter
    if (!filterData.searchValue || filterData.searchValue.trim() === '') {
      await clearAllFilters()
      isFiltering.value = false
      dismissLoading()
      return
    }

    // Store the search string and column for pagination
    currentSearchString.value = filterData.searchValue
    currentSearchColumn.value = filterData.searchColumn

    // Reset to first page
    currentPageRef.value = 1
    paginationState.currentPage = 1
    allListingsData.value = []  // Reset data

    const filterParams = {
      searchColumn: filterData.searchColumn,
      searchValue: filterData.searchValue,
      division: currentCategory.value,
      orderBy: 'id',
      order: 'desc'
    }

    // Fetch first batch (1000 items)
    let result
    if (generalStore.listingShowingType === 'personal') {
      result = await ListingService._getPaginatedListings(1, 1000, filterParams)
    } else {
      result = await ListingService._getOtherBrokerListingsPaginated(1, 1000, filterParams)
    }

    if (result.error) {
      console.error('Error fetching filtered listings:', result.error)
      showToast({
        title: 'Error filtering listings',
        icon: 'error',
      })
      return
    }

    // Sort first batch
    let sortedData = result.data?.sort((a, b) => (b.listing_id || b.id) - (a.listing_id || a.id)) || []

    console.log('Filtered first batch count:', sortedData.length)
    console.log('First 10 filtered IDs:', sortedData.slice(0, 10).map(d => d.listing_id || d.id))

    // Store for pagination
    allListingsData.value = sortedData

    // Same count-guard pattern as getListings — see comment there.
    const FIRST_BATCH_SIZE = 1000
    const firstBatchFull = sortedData.length >= FIRST_BATCH_SIZE
    const knownTotal = firstBatchFull ? result.total : sortedData.length
    const totalBatches = firstBatchFull ? result.totalPages : 1

    // Update pagination state
    paginationState.total = knownTotal
    paginationState.totalPages = Math.ceil(knownTotal / (pageItemsCountRef.value || 10))

    // Process with localStorage operations
    const currentListings = await completeCorrectOperationsForEachKey({
      data: sortedData
    })

    // Re-sort after localStorage operations
    if (currentListings.data && currentListings.data.length > 0) {
      currentListings.data.sort((a, b) => (b.listing_id || b.id) - (a.listing_id || a.id))
      allListingsData.value = currentListings.data
    }

    console.log('After localStorage, filtered count:', allListingsData.value.length)

    // Display first page of filtered results
    await displayPageData(1)

    // Check for cross-category results
    await checkCrossCategoryResults(filterData.searchValue, filterData.searchColumn)

    console.log('Filtered data:', paginatedListings.value.length, 'items')

    // Fetch remaining filtered batches in background
    if (totalBatches > 1) {
      console.log(`Fetching remaining ${totalBatches - 1} filtered batches in background...`)
      fetchRemainingFilteredBatches(filterParams, totalBatches)
    }
  } catch (error) {
    console.error('Error filtering data:', error)
    showToast({
      title: 'Error filtering data',
      icon: 'error',
    })
  } finally {
    isFiltering.value = false
    dismissLoading()
  }
}

// Fetch remaining filtered batches in background. Same defensive stop
// conditions as fetchRemainingBatches above — abort on error or empty.
const fetchRemainingFilteredBatches = async (filterParams: any, totalBatches: number) => {
  try {
    for (let pageNum = 2; pageNum <= totalBatches; pageNum++) {
      console.log(`Background: Fetching filtered batch ${pageNum}/${totalBatches}...`)

      let result
      if (generalStore.listingShowingType === 'personal') {
        result = await ListingService._getPaginatedListings(pageNum, 1000, filterParams)
      } else {
        result = await ListingService._getOtherBrokerListingsPaginated(pageNum, 1000, filterParams)
      }

      if (result.error) {
        console.warn(`Filtered batch ${pageNum} stopped on error; aborting.`, result.error)
        break
      }

      if (!result.data || result.data.length === 0) {
        console.log(`Filtered batch ${pageNum} returned empty; aborting.`)
        break
      }

      // Sort before appending
      result.data.sort((a: any, b: any) => (b.listing_id || b.id) - (a.listing_id || a.id))
      allListingsData.value.push(...result.data)
      console.log(`Filtered batch ${pageNum} appended, total now: ${allListingsData.value.length}`)

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    console.log('All filtered batches fetched and cached')
  } catch (error) {
    console.warn('Error fetching remaining filtered batches:', error)
    // Don't fail - we already have first batch loaded
  }
}

async function clearAllFilters() {
  // Reset search state
  currentSearchString.value = ''
  currentSearchColumn.value = ''
  crossCategoryResults.value = {
    residential: 0,
    commercial: 0,
    hasCrossCategory: false
  }

  // Reset to first page
  currentPageRef.value = 1
  paginationState.currentPage = 1

  // Reload all listings
  await getListings()

  console.log('Cleared all filters')
}

async function checkCrossCategoryResults(searchValue: string, searchColumn: string) {
  const nuxtApp = useNuxtApp()

  try {
    // Reads from `listing_details` (canonical wide read source). Only
    // listing_id is selected because we just need a count.
    const [residentialResults, commercialResults] = await Promise.all([
      useSupabaseClient()
        .from('listing_details')
        .select('listing_id')
        .eq('property_category', 'residential')
        .ilike(searchColumn, `%${searchValue}%`),
      useSupabaseClient()
        .from('listing_details')
        .select('listing_id')
        .eq('property_category', 'commercial')
        .ilike(searchColumn, `%${searchValue}%`),
    ])

    if (residentialResults.error) {
      console.error('Residential search failed:', residentialResults.error.message)
    }
    if (commercialResults.error) {
      console.error('Commercial search failed:', commercialResults.error.message)
    }

    const residentialCount = residentialResults.data?.length || 0
    const commercialCount = commercialResults.data?.length || 0

    crossCategoryResults.value = {
      residential: residentialCount,
      commercial: commercialCount,
      hasCrossCategory: residentialCount > 0 && commercialCount > 0
    }

    console.log('Cross-category results:', crossCategoryResults.value)
  } catch (error) {
    console.error('Error checking cross-category results:', error)
  }
}

function capitalizeFirstLetter(string: string) {
  if (!string) return ''
  return string.charAt(0).toUpperCase() + string.slice(1)
}

async function generateAvailableFilters() {
  availableFilters.fors = [
    { id: 'rent', name: 'Rent', selected: false },
    { id: 'sale', name: 'Sale', selected: false },
  ] as any

  availableFilters.types = [
    { id: 'condo', name: 'Condo', selected: false },
    { id: 'house', name: 'House', selected: false },
    { id: 'warehouse', name: 'Warehouse', selected: false },
    { id: 'lot', name: 'Lot', selected: false },
    { id: 'building', name: 'Building', selected: false },
    { id: 'office-space', name: 'Office Space', selected: false },
    { id: 'serviced-space', name: 'Serviced Office', selected: false },
    { id: 'villa', name: 'Villa', selected: false },
    { id: 'hotel', name: 'Hotel', selected: false },
    { id: 'resort', name: 'Resort', selected: false },
  ] as any

  availableFilters.conditions = [] as any

  const url = UrlBuilder.createFromUrl(window.location.href)
  const division = url.getQueryParams().get('division')
  availableFilters.conditions.push(
    { id: 'fully-furnished', name: 'Fully Furnished', selected: false },
    { id: 'semi-furnished', name: 'Semi Furnished', selected: false },
    { id: 'unfurnished', name: 'Unfurnished', selected: false },
    { id: 'bare-shell', name: 'Bare Shell', selected: false },
    { id: 'warm-shell', name: 'Warm Shell', selected: false },
    { id: 'fitted-out', name: 'Fitted Out', selected: false },
    { id: 'as-is-where-is', name: 'As Is Where Is', selected: false }
  )

  console.log('availableFilters: ', availableFilters)

  
  const nuxtApp = useNuxtApp()
  // Fetch cities from database
  try {
    const { data: citiesData, error: citiesError } = await useSupabaseClient()
      .from('cities')
      .select('id, name, slug')
      .order('name')
    
    if (citiesError) {
      console.error('Error fetching cities:', citiesError)
    } else {
      availableFilters.cities = citiesData.map(city => ({
        id: city.slug,
        name: city.name,
        city_id: city.id
      }))
      console.log('Fetched cities:', availableFilters.cities)
    }
  } catch (error) {
    console.error('Error fetching cities:', error)
  }

  // Fetch barangays from database
  try {
    const { data: barangaysData, error: barangaysError } = await useSupabaseClient()
      .from('barangays')
      .select('id, name, slug, city_id')
      .order('name')
    
    if (barangaysError) {
      console.error('Error fetching barangays:', barangaysError)
    } else {
      availableFilters.barangays = barangaysData.map(barangay => ({
        id: barangay.slug,
        name: barangay.name,
        city_id: barangay.city_id,
        barangay_id: barangay.id // Store the numeric ID for filtering
      }))
      console.log('Fetched barangays:', availableFilters.barangays.length)
    }
  } catch (error) {
    console.error('Error fetching barangays:', error)
  }
}

const toggleListingsShowingType = async () => {
  console.log('userCanViewAllListings: ', userCanViewAllListings.value)

  if (!userCanViewAllListings.value) {
    return
  }

  generalStore.listingShowingType =
    generalStore.listingShowingType === 'personal' ? 'broker' : 'personal'

  // change query param view=listingsShowingType
  const urlBuilder = UrlBuilder.createFromUrl(window.location.href)
  urlBuilder.getQueryParams().set('view', generalStore.listingShowingType)
  console.log('urlBuilder: ', urlBuilder)

  //use the new urlBuilder to update the url
  window.history.pushState({}, '', urlBuilder.toString())

  // Reset to first page when changing view type
  currentPageRef.value = 1
  paginationState.currentPage = 1

  await getListings()
}

const advancedFiltersSidebarOpen = ref<boolean>(false)
const tableViewOptionsSidebarOpen = ref<boolean>(false)
const listingDetailsSidebarOpen = ref<boolean>(false)
const imageGalleryModalOpen = ref<boolean>(false)
const selectedListingId = ref<number>(0)

function toggleAdvancedFiltersSidebar() {
  advancedFiltersSidebarOpen.value = !advancedFiltersSidebarOpen.value
  tableViewOptionsSidebarOpen.value = false
  listingDetailsSidebarOpen.value = false
}

function toggleTableViewOptionsSidebar() {
  tableViewOptionsSidebarOpen.value = !tableViewOptionsSidebarOpen.value
  advancedFiltersSidebarOpen.value = false
  listingDetailsSidebarOpen.value = false
}

const showMoreOptionsOpen = ref<boolean>(false)

function toggleMoreOptionsDropdown() {
  showMoreOptionsOpen.value = !showMoreOptionsOpen.value
}

function closeMoreOptionsDropdown() {
  showMoreOptionsOpen.value = false
}

function handleMoreOptionsSelect(action: 'table' | 'filters') {
  if (action === 'table') {
    toggleTableViewOptionsSidebar()
  } else {
    toggleAdvancedFiltersSidebar()
  }
  closeMoreOptionsDropdown()
}

function toggleListingDetailsSidebar(listingId: number) {
  console.log('listingId: ', listingId)
  tableViewOptionsSidebarOpen.value = false
  advancedFiltersSidebarOpen.value = false

  console.log('listings: ', listings)
  const selectedListing = listingColumnsData.find(
    (listing) => listing.listing_data.listing_id == listingId
  ) as ListingColumns

  if (
    !listingDetailsSidebarOpen.value &&
    selectedListingDetails.value?.listing_data.listing_id !== listingId
  ) {
    listingDetailsSidebarOpen.value = true
    selectedListingDetails.value = selectedListing
    selectedListingId.value = listingId
    console.log('selectedListingDetails: ', selectedListingDetails.value)
  } else {
    listingDetailsSidebarOpen.value = false
    selectedListingDetails.value = null
  }
}

function toggleImageGallery() {
  imageGalleryModalOpen.value = !imageGalleryModalOpen.value
}

function showUpdateListingForm(listingId: number) {
  // Modal-based edit flow shared the create flow's TDZ crash path; edit
  // now lives at /listings/:id/edit. NewForm fetches the canonical row
  // by id internally (same behavior as before), so callers don't need
  // to pre-load anything.
  router.push(`/listings/${listingId}/edit`)
}

const previousPage = () => {
  //console.log("previousPage: ", currentPageRef.value)

  if (currentPageRef.value == 1) {
    return
  }

  currentPageRef.value = currentPageRef.value - 1
}

const nextPage = () => {
  //console.log("nextPage: ", currentPageRef.value)

  if (currentPageRef.value == totalPages.value) {
    return
  }

  currentPageRef.value = currentPageRef.value + 1
}

async function toggleCategory(category: string) {
  currentCategory.value = category;

  // update url
  const urlBuilder = UrlBuilder.createFromUrl(window.location.href)
  urlBuilder.getQueryParams().set('division', category)
  window.history.pushState({}, '', urlBuilder.toString())

  // Reset to first page when changing category
  currentPageRef.value = 1
  paginationState.currentPage = 1

  // Fetch all listings for the new category
  await getListings();

  if (currentSearchString.value && currentSearchColumn.value) {
    await handleFilterTableData({
      searchColumn: currentSearchColumn.value,
      searchValue: currentSearchString.value,
    });
  }
}

async function handleDisplayStatusChange(status: string) {
  displayStatusFilter.value = status
  
  // Reset to first page when changing filter
  currentPageRef.value = 1
  paginationState.currentPage = 1
  
  // Fetch all listings with new filter
  await getListings()
}
</script>

<template>
  <!-- Image Gallery -->
  <ImageGallery :imageGalleryOpen="imageGalleryModalOpen" @toggleImageGallery="toggleImageGallery"
    :listingId="selectedListingId" />

  <div class="w-full">
    <div class="flex w-[full] relative">
      <div class="flex-col flex-1 px-6 pb-4 w-0">
        <UiPageHeader
          class="mb-5 mt-6"
          title="Listings"
          description="Browse, edit, and manage your team's properties."
        />
        <!-- Division Tabs — view + category as two pill segmented controls.
             Replaces the previous "show only the active state, click to flip"
             pattern with both options always visible (clearer UX, fewer
             surprised clicks). Behavior is preserved — onUpdate handlers
             still call the original toggle/setter functions. -->
        <nav class="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div class="flex flex-wrap items-center gap-3">
            <UiTabBar
              variant="pill"
              :model-value="generalStore.listingShowingType"
              :tabs="[
                { value: 'broker', label: 'All properties', disabled: !userCanViewAllListings },
                { value: 'personal', label: 'My properties' },
              ]"
              @update:model-value="(v) => v !== generalStore.listingShowingType && toggleListingsShowingType()"
            />
            <UiTabBar
              variant="pill"
              :model-value="currentCategory"
              :tabs="[
                { value: 'residential', label: 'Residential' },
                { value: 'commercial', label: 'Commercial' },
              ]"
              @update:model-value="(v) => v !== currentCategory && toggleCategory(v as string)"
            />
            <!-- Photo filter — applied client-side on top of the paged
                 result set. Reads listing_data.has_photo (derived from
                 listing_details MV's image_name). Pure UI filter; does
                 not refetch. -->
            <UiTabBar
              variant="pill"
              :model-value="photoFilter"
              :tabs="[
                { value: 'all',     label: 'All photos' },
                { value: 'with',    label: 'With photo' },
                { value: 'without', label: 'Without photo' },
              ]"
              @update:model-value="(v) => (photoFilter = v as PhotoFilter)"
            />
          </div>
          <div class="lg:hidden flex w-12 sm:w-24 justify-evenly gap-2 items-end py-4">
            <div class="relative" v-on-clickaway="closeMoreOptionsDropdown">
              <div
                class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 hover:bg-primary/10 w-[12vw] gap-2"
                :class="{ 'bg-primary/10': showMoreOptionsOpen }" @click="toggleMoreOptionsDropdown">
                <font-awesome-icon :icon="['fas', 'bars']" class="text-gray-80 group-hover:text-primary"
                  :class="{ 'text-primary': showMoreOptionsOpen }" size="md" />
                <!-- <span class="text-sm">More</span>
                <font-awesome-icon
                  :icon="['fas', 'chevron-down']"
                  class="text-gray-80 transition-transform duration-200"
                  :class="{ 'rotate-180 text-primary': showMoreOptionsOpen }"
                  size="sm"
                /> -->
              </div>

              <div v-if="showMoreOptionsOpen"
                class="absolute right-0 mt-2 w-64 bg-card shadow-lg rounded-lg z-50 border border-border">
                <div class="py-1">
                  <button class="w-full text-left px-4 py-2 hover:bg-primary/10 flex items-center gap-2"
                    @click="handleMoreOptionsSelect('table')">
                    <font-awesome-icon :icon="['fas', 'table-columns']" class="text-gray-80"
                      :class="{ 'text-primary': tableViewOptionsSidebarOpen }" size="sm" />
                    <span class="text-sm">Table View Options</span>
                  </button>

                  <button class="w-full text-left px-4 py-2 hover:bg-primary/10 flex items-center gap-2"
                    @click="handleMoreOptionsSelect('filters')">
                    <font-awesome-icon :icon="['fas', 'filter']" class="text-gray-80"
                      :class="{ 'text-primary': advancedFiltersSidebarOpen }" size="sm" />
                    <span class="text-sm">Advanced Filters</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="hidden lg:flex min-w-[5vw] justify-evenly gap-2 items-end py-4">
            <!-- Phase 3: saved views. localStorage-backed, per-user, scoped to
                 'listings'. Captures the full URL (filters + search + paging)
                 so loading restores everything that's URL-synced today. -->
            <SavedViewsDropdown scope="listings" class="self-center" />
            <div
              class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 hover:bg-primary/10 w-[10vw] gap-2"
              :class="{ 'bg-primary/10': tableViewOptionsSidebarOpen }" @click="toggleTableViewOptionsSidebar"> <span
                class="text-sm">Table View Options</span> <font-awesome-icon :icon="['fas', 'table-columns']"
                class="text-gray-80 group-hover:text-primary" :class="{ 'text-primary': tableViewOptionsSidebarOpen }"
                size="md" /> </div>
            <div
              class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 hover:bg-primary/10 w-[10vw] gap-2"
              :class="{ 'bg-primary/10': advancedFiltersSidebarOpen }" @click="toggleAdvancedFiltersSidebar"> <span
                class="text-sm">Advanced Filters</span> <font-awesome-icon :icon="['fas', 'filter']"
                class="text-foreground group-hover:text-primary" :class="{ 'text-primary': advancedFiltersSidebarOpen }"
                size="md" /> </div>
          </div>
        </nav>

        <!-- Search Section -->
        <SearchSection @toggleListingDetailsSidebar="toggleListingDetailsSidebar" @addListing="addListing"
          @getListings="getListings" @toggleAdvancedFiltersSidebar="toggleAdvancedFiltersSidebar"
          @FilterTableData="handleFilterTableData" :listingColumnsData="listingColumnsData" />

        <!-- Saved views: bookmark the current URL-synced filter combination -->
        <div class="mb-4">
          <SavedViewsBar scope="listings" />
        </div>

        <!-- Display Status Filter — segmented control -->
        <div class="mb-4 flex items-center gap-3" role="group" aria-label="Display status">
          <span class="text-sm font-semibold text-foreground">Display:</span>
          <div class="inline-flex items-center rounded-lg border border-border bg-card p-0.5 text-sm">
            <button
              v-for="option in [
                { value: 'all', label: 'All' },
                { value: 'online', label: 'Online' },
                { value: 'offline', label: 'Offline' },
              ]"
              :key="option.value"
              type="button"
              :aria-pressed="displayStatusFilter === option.value"
              :class="[
                'inline-flex items-center justify-center rounded-md px-3 h-8 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                displayStatusFilter === option.value
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              ]"
              @click="() => {
                displayStatusFilter = option.value
                handleDisplayStatusChange(option.value)
              }"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <!-- Applied filters cards -->
        <div class="mb-4" v-if="Object.keys(appliedFilters).length > 0 || originalListingColumnsData.length > 0">
          <span class="font-bold text-[.9vw]">Applied filters: </span>
          <div class="flex gap-2 flex-wrap">
            <div v-for="filter in Object.keys(appliedFilters)" :key="filter"
              v-if="appliedFilters[filter] != '' || appliedFilters[filter] != 0"
              class="flex bg-muted rounded-lg p-2 items-center gap-2">
              <font-awesome-icon icon="xmark" class="cursor-pointer" @click="removeFilter(filter)" />
              <span>{{ filter }}: {{ appliedFilters[filter] }}</span>
            </div>
            <!-- Search Filter -->
            <div v-if="originalListingColumnsData.length > 0"
              class="flex bg-primary/15 rounded-lg p-2 items-center gap-2">
              <font-awesome-icon icon="xmark" class="cursor-pointer" @click="clearAllFilters" />
              <span v-if="isFiltering" class="flex items-center gap-2">
                <svg class="animate-spin h-4 w-4 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none"
                  viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z">
                  </path>
                </svg>
                Filtering...
              </span>
              <span v-else>Search: "{{ currentSearchString }}"</span>
            </div>
          </div>
        </div>

        <!-- Cross-category warning banner -->
        <!-- <div 
          v-if="crossCategoryResults.hasCrossCategory && originalListingColumnsData.length > 0"
          class="mb-4 p-3 bg-yellow-100 border border-yellow-400 rounded-lg"
        >
          <div class="flex items-center gap-2">
            <font-awesome-icon icon="exclamation-triangle" class="text-yellow-600" />
            <span class="font-semibold text-yellow-800">
              Cross-category results found!
            </span>
          </div>
          <p class="text-yellow-700 mt-1 text-sm">
            Your search found {{ crossCategoryResults.residential }} residential and {{ crossCategoryResults.commercial }} commercial properties. 
            <span v-if="currentCategory === 'residential'">
              Switch to <button @click="toggleCategory('commercial')" class="underline font-semibold">Commercial</button> to see all results.
            </span>
            <span v-else>
              Switch to <button @click="toggleCategory('residential')" class="underline font-semibold">Residential</button> to see all results.
            </span>
          </p>
        </div> -->

        <!-- Table -->
        <div>
          <!-- Error state replaces the table on a fatal load failure. The
               table component still renders skeleton rows during normal
               loading; this is for the cases where we have nothing to
               render at all. -->
          <ListingsErrorState
            v-if="listingsLoadError"
            :message="listingsLoadError"
            :retrying="isRetrying"
            @retry="retryGetListings"
          />
          <!-- Day-1 empty state: gated on the load having completed
               (`fetchListingsEnded`), zero rows total, and no active
               filters/search. Prevents flicker before the first load
               returns and prevents shadowing the table's own
               filter-narrow message. -->
          <div
            v-else-if="
              fetchListingsEnded &&
              paginationState.total === 0 &&
              !currentSearchString &&
              !currentSearchColumn &&
              currentAvailabilityType === 'all'
            "
            class="rounded-lg border border-border bg-card p-5 text-card-foreground"
          >
            <div class="mx-auto max-w-md text-center">
              <h3 class="text-lg font-semibold text-foreground">No listings yet</h3>
              <p class="mt-2 text-sm text-muted-foreground">
                Add your first listing to start receiving inquiries from buyers and tenants on the public site.
              </p>
              <div class="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
                <NuxtLink
                  to="/listings/new"
                  class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Create your first listing
                  <span aria-hidden="true">→</span>
                </NuxtLink>
              </div>
            </div>
          </div>
          <!-- View toggle (Cards / Table) — sits above the listings
               surface. Cards is the default for visibility on any
               viewport; Table is the legacy power-user view with
               column visibility settings. -->
          <div v-else class="mb-3 flex items-center justify-between gap-2">
            <div role="radiogroup" aria-label="Listings view" class="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 p-0.5">
              <button
                type="button"
                role="radio"
                :aria-checked="listingsView === 'cards'"
                :class="[
                  'h-7 rounded-sm px-3 text-xs font-medium transition-colors focus-ring',
                  listingsView === 'cards'
                    ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
                    : 'text-muted-foreground hover:text-foreground',
                ]"
                @click="listingsView = 'cards'"
              >
                Cards
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="listingsView === 'table'"
                :class="[
                  'h-7 rounded-sm px-3 text-xs font-medium transition-colors focus-ring',
                  listingsView === 'table'
                    ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
                    : 'text-muted-foreground hover:text-foreground',
                ]"
                @click="listingsView = 'table'"
              >
                Table
              </button>
            </div>
            <p class="text-xs text-muted-foreground">
              {{ paginationState.total.toLocaleString() }} listing{{ paginationState.total === 1 ? '' : 's' }}
              <span v-if="photoFilter !== 'all'">
                · showing {{ displayListings.length.toLocaleString() }} {{ photoFilter === 'with' ? 'with photo' : 'without photo' }}
              </span>
            </p>
          </div>

          <!-- Cards view (default) — fits any viewport, no horizontal
               scroll, primary operational fields visible inline.
               Table view is the legacy column-dense layout for power
               users; both share the not-error-and-not-empty gate via
               the wrapping <template>. -->
          <template
            v-if="!listingsLoadError && !isInDayOneEmptyState"
          >
            <ListingsCardGrid
              v-if="listingsView === 'cards'"
              :listings="displayListings"
              :selection-enabled="true"
              :is-row-selected="(id) => selection.has(id)"
              @show-listing-details="(id) => toggleListingDetailsSidebar(id)"
              @toggle-row="(id) => selection.toggle(id)"
              @show-history="openHistoryDrawer"
            />

            <ListingsTable
              v-else-if="listingsView === 'table'"
            :currentAvailabilityType="currentAvailabilityType"
            :columnsData="displayListings"
            :currentPage="filteredListingColumns.currentPage"
            :currentCategory="currentCategory"
            :hasActiveFilters="
              !!(
                currentSearchString ||
                currentSearchColumn ||
                currentAvailabilityType !== 'all'
              )
            "
            :selectionEnabled="true"
            :isRowSelected="(id) => selection.has(id)"
            @sortingFunction="sortingFunction"
            @toggleListingDetailsSidebar="toggleListingDetailsSidebar"
            @toggleOptionsMenu="toggleOptionsMenu"
            @showUpdateListingForm="showUpdateListingForm"
            @dataProcessed="handleDataProcessed"
            @toggleContactInfoModal="showContactInformationModal"
            @showUpdateAvailabilityModal="showUpdateAvailabilityModal"
            @changeAvailabilityType="changeAvailabilityType"
            @triggerListingEnablement="triggerListingEnablement"
            @triggerStatusSwitch="triggerStatusSwitch"
            @sortByPrice="sortByPrice"
            @clearFilters="resetFilters"
            @createListing="addListing"
            @toggleRow="(id) => selection.toggle(id)"
            @toggleAllOnPage="
              selection.toggleAll(
                paginatedListings
                  .map((c) => c.listing_data?.listing_id)
                  .filter(Boolean),
              )
            "
            @showHistory="openHistoryDrawer"
          >
          </ListingsTable>
          </template>
          <!-- Listing change-history drawer. Reads activities filtered
               by metadata.listing_id; populated by listing.* audit
               verbs + the listings_audit_diff trigger that captures
               field-level diffs on UPDATE. -->
          <ListingHistoryDrawer
            :open="historyDrawerOpen"
            :listing-id="historyDrawerListingId"
            @close="closeHistoryDrawer"
          />
          <!-- Bulk action bar — sticky-bottom, only renders when â‰¥1
               selected. Selection persists across pagination so users
               can build a multi-page selection without losing rows. -->
          <BulkActionsBar
            :count="selection.size.value"
            :busy="isBulkBusy"
            @archive="handleBulkArchive"
            @unarchive="handleBulkUnarchive"
            @softDelete="handleBulkSoftDelete"
            @clear="selection.clear()"
          />
        </div>
        <div class="flex flex-col sm:flex-row gap-3 sm;gap-0 justify-between w-full mb-5 lg:mb-0">
          <div class="flex items-center justify-center gap-2 w-full sm:w-[34%]">
            <!-- Range copy reads as "Showing 11–20 of 47 listings · Page 2 of 5".
                 rangeStart / rangeEnd are computed inline to avoid adding more
                 reactive state for a presentational nicety. -->
            <p class="text-xs sm:text-sm text-foreground" v-if="paginationState.total > 0">
              Showing
              <span class="font-medium">{{
                (currentPageRef - 1) * pageItemsCountRef + 1
              }}</span>–<span class="font-medium">{{
                Math.min(
                  currentPageRef * pageItemsCountRef,
                  paginationState.total,
                )
              }}</span>
              of
              <span class="font-medium">{{ paginationState.total }}</span>
              listings
              <span class="text-muted-foreground"
                >· Page {{ currentPageRef }} of {{ paginationState.totalPages || 1 }}</span
              >
            </p>
            <p v-else class="text-xs sm:text-sm text-muted-foreground">No listings to show</p>
          </div>
          <div class="flex items-center justify-center gap-2 w-full sm:w-auto flex-wrap sm:flex-nowrap">
            <!-- Previous Button -->
            <button 
              class="text-xs sm:text-sm cursor-pointer bg-muted rounded-lg px-3 py-2 hover:bg-muted transition-colors whitespace-nowrap"
              :class="{ 'opacity-50 cursor-not-allowed': currentPageRef === 1 }"
              @click="currentPageRef > 1 ? handlePageChange(currentPageRef - 1) : null"
              :disabled="currentPageRef === 1">
              Previous
            </button>
            
            <!-- Page Numbers -->
            <template v-for="(page, index) in displayedPageNumbers" :key="index">
              <span 
                v-if="page === '...'" 
                class="px-2 py-1 text-muted-foreground">
                ...
              </span>
              <button 
                v-else
                @click="handlePageChange(page)"
                class="min-w-[2rem] px-3 py-2 text-xs sm:text-sm rounded-lg transition-colors"
                :class="currentPageRef === page 
                  ? 'bg-primary text-white font-semibold' 
                  : 'bg-muted hover:bg-muted cursor-pointer'">
                {{ page }}
              </button>
            </template>
            
            <!-- Next Button — disabled on the last page AND when there are
                 zero pages (empty result set). Pre-fix the latter was leaking
                 a clickable Next on empty results. -->
            <button
              class="text-xs sm:text-sm cursor-pointer bg-muted rounded-lg px-3 py-2 hover:bg-muted transition-colors whitespace-nowrap"
              :class="{
                'opacity-50 cursor-not-allowed':
                  currentPageRef >= paginationState.totalPages || paginationState.totalPages === 0,
              }"
              @click="
                currentPageRef < paginationState.totalPages
                  ? handlePageChange(currentPageRef + 1)
                  : null
              "
              :disabled="
                currentPageRef >= paginationState.totalPages || paginationState.totalPages === 0
              "
            >
              Next
            </button>
          </div>
          <div class="hidden sm:block w-[33%]"></div>
        </div>
        <!-- Pagination -->
      </div>
      <div v-if="listingDetailsSidebarOpen" class="flex flex-col sm:w-[33%] h-full bg-card sm:static absolute z-10 w-full">
        <!-- Listing Details -->
        <SidebarListingDetails :selectedListingDetails="selectedListingDetails"
          :listingDetailsSidebarOpen="listingDetailsSidebarOpen"
          @toggleSidebarListingDetails="toggleListingDetailsSidebar" @toggleImageGallery="toggleImageGallery"
          @toggleOptionsMenu="toggleOptionsMenu" @showUpdateListing="showUpdateListingForm" />
      </div>
      
      <!-- Advanced Filters Modal -->
      <AdvanceFilters 
        :advancedFiltersSidebarOpen="advancedFiltersSidebarOpen"
        @toggleAdvancedFiltersSidebar="toggleAdvancedFiltersSidebar"
        :availableFilters="availableFilters" 
        @resetFilters="resetFilters" 
        @applyFilters="applyFilters" 
      />
      
      <div v-if="tableViewOptionsSidebarOpen" class="flex flex-col sm:w-[25%] sm:h-[39vw] p-8 sm:p-0 sm:static bg-card absolute z-50 w-full h-full">
        <!-- Table View Options -->
        <TableViewOptions :tableViewOptionsSidebarOpen="tableViewOptionsSidebarOpen"
          :listingColumnsData="listingColumnsData" @toggleTableViewOptionsSidebar="toggleTableViewOptionsSidebar" />
      </div>
    </div>

    <!-- MODALS -->
    <Modal
      :title="`Update availability for ${currentListingForAvailabilityUpdate?.listing_id} - ${currentListingForAvailabilityUpdate?.title}`"
      ref="updateAvailabilityModal">
      <div class="p-4 flex flex-col justify-center items-center">
        <p class="min-w-[20vw] flex flex-col items-center">
          <span class="font-bold text-foreground my-4">Edit availability for this listing </span>
          <!-- Lease Starting Date -->
        <div class="mb-2">
          <Input id="availability" type="date" :model-value="newTemporaryAvailability" @change="
            (value) => {
              newTemporaryAvailability = value
            }
          " required>Availability</Input>
        </div>
        <button
          :class="!checkIfAvailabilityIsChanged() ? 'bg-primary text-primary-foreground px-4 py-2 rounded-lg mt-4 transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring' : 'bg-green text-white px-4 py-2 rounded-lg mt-4'"
          @click="async () => {
            const newAvailability = checkIfAvailabilityIsChanged()
            console.log('newAvailability: ', newAvailability)
            if (!newAvailability) {
              updateAvailabilityModal.toggleModal()
            }

            if (newAvailability) {
              showLoading()
              await updateAvailability()
              dismissLoading()
              updateAvailabilityModal.toggleModal()
            }
          }">
          {{ checkIfAvailabilityIsChanged() ? 'Update' : 'Close' }}
        </button>
        </p>
      </div>
    </Modal>
    <!-- Contact Information -->
    <Modal :title="'Contact Information'" ref="contactInfoModal">
      <div class="p-4 flex flex-col justify-center items-center">
        <p class="min-w-[25vw] flex justify-between">
          <span class="font-bold text-foreground">Name: </span>
          <span>{{ contactData?.full_name || '-' }}</span>
        </p>
        <p class="min-w-[25vw] flex justify-between">
          <span class="font-bold text-foreground">Designation: </span>
          <span @click="sortContactDesignation(contactData)">{{
            contactData?.designation || '-'
          }}</span>
        </p>
        <p class="min-w-[25vw] flex justify-between">
          <span class="font-bold text-foreground">Email: </span>
          <span>{{ contactData?.email || '-' }}</span>
        </p>
        <p class="min-w-[25vw] flex justify-between">
          <span class="font-bold text-foreground">Home phone: </span>
          <span>{{ contactData?.home_phone || '-' }}</span>
        </p>

        <p class="min-w-[25vw] flex justify-between">
          <span class="font-bold text-foreground">Mobile phone:</span>
          <span>{{ contactData?.mobile_phone || '-' }}</span>
        </p>
        <p class="min-w-[25vw] flex justify-between">
          <span class="font-bold text-foreground">Social Media Link:</span>
          <a v-if="contactData?.link" :href="contactData.link" target="_blank">Open Link</a>
          <span v-else>-</span>
        </p>
        <p class="min-w-[25vw] flex justify-between">
          <span class="font-bold text-foreground">Notes:</span>
          <span class="max-w-[15vw]">{{
            contactData?.notes || '-'
          }}</span>
        </p>
        <button class="bg-blue text-white px-4 py-2 rounded-lg mt-4" @click="() => contactInfoModal.toggleModal()">
          Close
        </button>
      </div>
    </Modal>

    <!-- Status Information -->
    <Modal
      :title="`Update status for ${currentListingForAvailabilityUpdate?.listing_id} - ${currentListingForAvailabilityUpdate?.title}`"
      ref="updateStatusModal" @close="updateStatusModal.toggleModal()">
      <div class="p-4 flex flex-col justify-center items-center">
        <p class="min-w-[20vw] h-[16vw] flex flex-col items-center">
          <span class="font-bold text-foreground my-4">Edit status for this listing</span>
          <!-- Status Dropdown -->
        <div class="mb-2 w-[15vw]">
          <VSelect required id="status" v-model="newTemporaryStatus" :clearable="false" :filterable="false"
            placeholder="Select status"
            @option:selected="() => { console.log('newTemporaryStatus: ', newTemporaryStatus) }" :options="[
              { 'label': 'AVAILABLE', 'value': 'available' },
              { 'label': 'TENANTED', 'value': 'occupied-rented' },
              { 'label': 'SOLD', 'value': 'sold' },
              { 'label': 'UNDER NEGOTIATION', 'value': 'under-negotiation' },
              { 'label': 'ON HOLD', 'value': 'on-hold' }]" label="label">Status</VSelect>
          <!-- <select
              id="status"
              v-model="newTemporaryStatus"
              class="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
              required
            >
              <option value="">Select Status</option>
              <option value="AVAILABLE">AVAILABLE</option>
              <option value="TENANTED">TENANTED</option>
              <option value="SOLD">SOLD</option>
              <option value="UNDER NEGOTIATION">UNDER NEGOTIATION</option>
              <option value="ON HOLD">ON HOLD</option>
            </select> -->
        </div>
        <button
          :class="!checkIfStatusIsChanged() ? 'bg-primary text-primary-foreground px-4 py-2 rounded-lg mt-4 transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring' : 'bg-green text-white px-4 py-2 rounded-lg mt-4'"
          @click="async () => {
            const newStatus = checkIfStatusIsChanged()
            console.log('newStatus: ', newStatus)
            if (!newStatus) {
              updateStatusModal.toggleModal()
            }

            if (newStatus) {
              showLoading()
              await updateListingStatusInstant(currentListingForAvailabilityUpdate.listing_id, newTemporaryStatus)
              dismissLoading()
              updateStatusModal.toggleModal()
            }
          }">
          {{ checkIfStatusIsChanged() ? 'Update' : 'Close' }}
        </button>
        </p>
      </div>
    </Modal>

    <!-- Gallery -->
    <Modal :title="'Photo Gallery'" ref="galleryModal">
      <Gallery :listingId="selectedListingId" />
    </Modal>

    <!-- Listing -->
    <Modal :title="modalTitle" ref="listingModal" width="sm:max-w-5xl">
      <NewForm ref="listingModalForm" :key="updateListingId || 'new'" :updateListingId="updateListingId"
        :listingData="selectedListing" :divisions="table.divisions" @toggleModal="closeListingModal"
        :types="table.types" />
    </Modal>

    <!-- Clone -->
    <Modal :title="`Clone Listing`" ref="listingCloneModal">
      <CloneForm ref="listingModalCloneForm" :listing="cloneListing" @submitCallback="afterCloneListing" />
    </Modal>

    <!-- Remarks -->
    <Modal :title="`Property Remarks`" ref="listingRemarksModal">
      <RemarksForm :listing="selectedListing" @submitCallback="closeRemarksModal" />
    </Modal>

    <!-- Image Download -->
    <Modal :title="`Image Downloads`" ref="imageDownloadModal">
      <div class="p-4">
        <div class="flex mb-2">
          <div class="px-1.5 pt-1.5 w-1/2 h-7">
            <input type="radio" id="imagesType" name="imagesType" class="hidden" v-model="imagesType" value="0" />
            <label for="" class="flex cursor-pointer" @click="chooseImageType(0)">
              <span class="block mr-2 w-4 h-4 rounded-full border" :class="imagesType == 0 ? ' bg-blue border-blue shadow-checkbox' : ''
                "></span>
              <span class="text-sm font-medium">With Watermark</span>
            </label>
          </div>
          <div class="px-1.5 pt-1.5 w-1/2 h-7">
            <input type="radio" id="imagesType" name="imagesType" class="hidden" v-model="imagesType" value="1" />
            <label for="" class="flex cursor-pointer" @click="chooseImageType(1)">
              <span class="block mr-2 w-4 h-4 rounded-full border" :class="imagesType == 1 ? ' bg-blue border-blue shadow-checkbox' : ''
                "></span>
              <span class="text-sm font-medium">Without Watermark</span>
            </label>
          </div>
        </div>
        <div class="flex mt-auto">
          <button type="button" class="flex ml-auto h-9 rounded-lg w-39 bg-green" @click="downloadAllImages()">
            <span class="block flex mx-auto mt-2 font-bold text-white">
              <svg class="mr-3 -ml-1 w-5 h-5 text-white animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none"
                viewBox="0 0 24 24" v-show="startDownload">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z">
                </path>
              </svg>
              Download
            </span>
          </button>
        </div>
      </div>
    </Modal>

    <!-- Quick Update -->
    <Modal :title="`Quick Update`" ref="listingQuickUpdateModal">
      <QuickUpdateForm :listing="selectedListing" :constants="optionSelections" :statuses="table.statuses"
        @submitCallback="closeQuickUpdateModal" />
    </Modal>

    <!-- Generate Report -->
    <Modal :title="'Properties Preview'" ref="generateReportModal">
      <SelectedPropertyPreview :division="listingsUrlParams.division"
        :selectedListings="selectedListingForGenerateReport" :searchColumns="table.searchColumns"
        @removeListing="removeListingFromGenerateReport" @addListing="addListingFromGenerateReport"
        @close="$refs.generateReportModal.toggleModal()" />
    </Modal>

    <!-- Table View Options -->
    <Modal :title="'Table View Options'" ref="settingsModal">
      <Settings :columns="table.columns || []" @change="columnChecked" @changeAll="showAllColumns" />
    </Modal>

    <!-- Log Form -->
    <Modal :title="`History Log`" ref="logFormModal">
      <LogForm :listingId="selectedListingId" @submitCallback="closeLogFormModal" />
    </Modal>

    <!-- Log List -->
    <Modal :title="modalTitle" ref="logListModal">
      <LogList :listingId="selectedListingId" />
    </Modal>
  </div>
</template>

<style>
body {
  overflow-x: hidden !important;
}

td {
  background: transparent !important;
}

.contact-logo-inline svg {
  display: inline;
}
</style>
