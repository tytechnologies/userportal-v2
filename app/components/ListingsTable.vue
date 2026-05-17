<style scoped>
/* Listings column sizing (Operations density).
 *
 * Was: width: 20vw + min-width: 5vw (viewport-relative). On a 1920px
 * screen that's ~384px per "header-listing" column × 8–12 visible
 * columns = the table grew to 5000–8000px wide and scrolled off the
 * page. The 1500px+ media query also disabled overflow-x entirely,
 * which silently CLIPPED the rightmost columns instead of revealing
 * a horizontal scrollbar — operators lost data without realizing it.
 *
 * Now: bounded rem-based min-widths produce a horizontally-scrollable
 * but reasonably-sized table at every viewport. The scroll affordance
 * is always available (overflow-x: auto with no media-query overrides)
 * and the sticky thead keeps headers visible while scrolling.
 */
.header-listing {
  min-width: 14rem;   /* 224px — the "Listing" column with title + thumbnail */
}

.header-text {
  font-size: 0.875rem;
  color: hsl(var(--primary));
}

.table-header {
  min-width: 6rem;    /* 96px — most other columns */
}

.table-scroll-container {
  overflow-x: auto;
  overflow-y: visible;
  /* Subtle right-edge fade so it's visually clear the table has
   * more content to the right when overflow exists. The mask drops
   * to zero at the very edge so the scrollbar still grabs cleanly. */
  mask-image: linear-gradient(
    to right,
    black 0,
    black calc(100% - 24px),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to right,
    black 0,
    black calc(100% - 24px),
    transparent 100%
  );
}

/* Drop the fade once the table actually fits — when the inner
 * scrollWidth equals clientWidth the fade is misleading. We can't
 * detect that purely in CSS, but at very wide viewports (1900px+)
 * most listings fit naturally. */
@media (min-width: 1900px) {
  .table-scroll-container {
    mask-image: none;
    -webkit-mask-image: none;
  }
}
</style>
<template>
  <div>
    <!-- Table — single scroll container (the prior nested pair caused
         layout confusion with two competing overflow rules). The
         table-scroll-container class enforces always-on horizontal
         scroll + a fade affordance on the right edge; the table is
         set to min-w-max so column widths win over the parent's
         natural width and the row stays scannable. -->
    <div ref="listingTableContainer" class="table-scroll-container">
      <div class="w-full">
        <table class="leading-normal table-auto min-w-max" id="listingTable">
          <thead class="sticky top-0 bg-card z-10">
            <tr>
              <!-- Bulk-select column. Hidden when the parent doesn't pass
                   selection state, so the existing public callers (deck,
                   archives, etc.) keep their old layout untouched. -->
              <th
                v-if="props.selectionEnabled"
                class="w-10 border-b border-border bg-card px-2 py-2"
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer accent-primary"
                  :checked="allOnPageSelected"
                  :indeterminate.prop="someOnPageSelected && !allOnPageSelected"
                  :aria-label="
                    allOnPageSelected ? 'Deselect all on this page' : 'Select all on this page'
                  "
                  @change="emit('toggleAllOnPage')"
                />
              </th>
              <th v-for="(item, index) in visibleColumnsWithIcons" :key="index"
                class="border-b border-border bg-card px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                <div
                  class="flex items-center justify-center gap-1 whitespace-nowrap">
                  <span v-if="item.name !== 'isOnline' && !item.icon" class="inline-flex items-center header-text">{{
                    item.name }}</span>
                  <span v-if="item.icon" class="inline-flex items-center  header-text" :title="item.name">
                    <font-awesome-icon :icon="item.icon" class="text-lg" />
                  </span>
                  <span v-if="item.name === 'isOnline'" class="flex justify-center items-center header-text w-[40px]">
                    <font-awesome-icon icon="fa-solid fa-check" class="text-lg" />
                  </span>
                  <div class="relative z-[100] availability-dropdown-container" v-if="item.name === 'Availability'">
                    <font-awesome-icon @click="toggleAvailabilityOptions" icon="chevron-circle-down"
                      class="text-gray-350 group-hover:text-primary cursor-pointer" size="lg" />
                    <div v-if="showAvailabilityOptions"
                      class="absolute top-[1vw] left-[-7vw] mt-2 text-sm bg-card rounded-lg shadow-lg p-4 z-[100] min-w-[150px]">
                      <div class="flex flex-col gap-2">
                        <label class="flex items-center gap-2 hover:bg-primary/10 cursor-pointer p-2 rounded-lg">
                          <input type="radio" name="availability" value="all" v-model="props.currentAvailabilityType"
                            @click="emit('changeAvailabilityType', 'all')"
                            class="w-4 h-4 cursor-pointer accent-primary" />
                          <span>All</span>
                        </label>
                        <label class="flex items-center gap-2 hover:bg-primary/10 cursor-pointer p-2 rounded-lg">
                          <input type="radio" name="availability" value="archived"
                            v-model="props.currentAvailabilityType" @click="emit('changeAvailabilityType', 'archived')"
                            class="w-4 h-4 cursor-pointer accent-primary" />
                          <span>Archived</span>
                        </label>
                        <label class="flex items-center gap-2 hover:bg-primary/10 cursor-pointer p-2 rounded-lg">
                          <input type="radio" name="availability" value="outdated"
                            v-model="props.currentAvailabilityType" @click="emit('changeAvailabilityType', 'outdated')"
                            class="w-4 h-4 cursor-pointer accent-primary" />
                          <span>Outdated</span>
                        </label>
                      </div>
                    </div>
                  </div>
                  <div class="relative z-[100] price-dropdown-container" v-if="item.name === 'Price'">
                    <font-awesome-icon @click="togglePriceOptions" icon="chevron-circle-down"
                      class="text-gray-350 group-hover:text-primary cursor-pointer" size="lg" />
                    <div v-if="showPriceOptions"
                      class="absolute top-[1vw] left-[-7vw] mt-2 text-sm bg-card rounded-lg shadow-lg p-4 z-[100] min-w-[150px]">
                      <div class="flex flex-col gap-2">
                        <label class="flex items-center gap-2 hover:bg-primary/10 cursor-pointer p-2 rounded-lg"
                          @click="sortByPrice('low-to-high')">
                          <font-awesome-icon icon="arrow-up" class="text-primary" />
                          <span>Low to High</span>
                        </label>
                        <label class="flex items-center gap-2 hover:bg-primary/10 cursor-pointer p-2 rounded-lg"
                          @click="sortByPrice('high-to-low')">
                          <font-awesome-icon icon="arrow-down" class="text-primary" />
                          <span>High to Low</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody class="relative text-sm">
            <!-- Skeleton rows during initial load. Hints at table density so
                 the user gets immediate visual feedback instead of a single
                 centered spinner. -->
            <tr
              v-if="isLoading"
              v-for="n in 8"
              :key="`skeleton-${n}`"
              class="animate-pulse"
            >
              <td v-if="props.selectionEnabled" class="px-2 py-3">
                <Skeleton class="h-4 w-4" />
              </td>
              <td
                v-for="col in visibleColumnsWithIcons"
                :key="`${n}-${col.column_name}`"
                class="px-3 py-3"
              >
                <Skeleton class="h-4 w-full max-w-[8rem]" />
              </td>
            </tr>
            <!-- <tr
              v-if="tempListings"
              v-for="tempListing in tempListings"
              :key="tempListing.id"
              class="relative bg-destructive/15 hover:bg-destructive/25 transition-colors duration-200"
            >
              <td
                v-if="tempListing.for === 'creation'"
                :colspan="visibleColumnsWithIcons.length"
                class="p-4 border-b border-destructive/30"
              >
                <div class="absolute top-0 right-0 h-full w-2"></div>
                <div class="flex items-center">
                  <div
                    :class="
                      tempListing.for === 'creation'
                        ? 'bg-primary/10'
                        : 'bg-destructive/10'
                    "
                    class="absolute inset-0 z-0"
                  ></div>
                  <div class="flex items-center gap-4 relative z-0">
                    <RowInfoCard
                      :index="tempListing.id"
                      :listing_data="tempListing"
                      :showOnlineStatus="true"
                      class="bg-card rounded-lg shadow-sm p-3 opacity-50"
                    />
                    <div
                      :class="
                        tempListing.for === 'creation'
                          ? 'text-primary text-lg font-medium'
                          : 'text-destructive text-lg font-medium'
                      "
                    >
                      {{
                        tempListing.for === 'creation'
                          ? 'New Listing Processing...'
                          : tempListing.for === 'deletion'
                          ? 'Listing Deletion Processing...'
                          : 'Unknown'
                      }}
                    </div>
                  </div>
                </div>
              </td>
            </tr> -->
            <ListingsTableRow
              v-if="!isLoading && displayedColumnsData.length > 0"
              v-for="(columnData, index) in displayedColumnsData"
              :key="`row-${columnData.listing_data.listing_id}-${index}`"
              :listing="columnData"
              :index="index"
              :is-deleting="checkIfListingIsForDeletion(columnData.listing_data.listing_id)"
              :row-classes="getRowClasses(columnData)"
              :selection-enabled="props.selectionEnabled"
              :is-selected="props.selectionEnabled && props.isRowSelected
                ? props.isRowSelected(columnData.listing_data.listing_id)
                : false"
              @toggleRow="(id) => emit('toggleRow', id)"
              @showListingDetails="(id) => toggleListingDetailsSidebar(id)"
              @openContactInfo="(id) => openContactInfo(id)"
              @openUpdateAvailability="(id, title, value) => openUpdateAvailabilityModal(id, title, value)"
              @triggerStatusSwitch="(id) => triggerStatusSwitch(id)"
              @triggerListingEnablement="(id) => triggerListingEnablement(id)"
              @showUpdateListing="(p) => showUpdateListing(p)"
              @showRemarksModal="(p) => showRemarksModal(p)"
              @showDownloadModal="(p) => showDownloadModal(p)"
              @showPropertyLogs="(p) => showPropertyLogs(p)"
              @showHistory="(id) => emit('showHistory', id)"
              @resetListings="resetListings"
              @showCloneListing="(p) => showCloneListing(p)"
              @getListings="getListings"
            />
            <slot />
            <tr v-if="!hasData && !isLoading">
              <td :colspan="listingColumnsArray.length + (props.selectionEnabled ? 1 : 0)">
                <ListingsEmptyState
                  :filtered="props.hasActiveFilters"
                  @clear="emit('clearFilters')"
                  @create="emit('createListing')"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import {
  useListingColumnsAtom,
  useListingsRawAtom,
  fetchListingsEnded,
} from '~/store'
import { currencySuffix } from '~/helpers/helpers'
import Actions from '~/components/pages/listings/ListingActions.vue'
import { useJustCreatedListingStore } from '~/store'
import { ref, computed, onBeforeMount, onMounted, onUnmounted, watch } from 'vue'
import { library } from '@fortawesome/fontawesome-svg-core'
import {
  faArrowDownWideShort,
  faArrowUpWideShort,
  faSortDown,
  faSortUp,
  faBed,
  faShower,
  faSquareParking,
  faCircleInfo,
  faGlobe,
  faArrowUp,
  faArrowDown,
} from '@fortawesome/free-solid-svg-icons'
import { formatCurrency } from '~/helpers/helpers'
import { can } from '~/composables/useAuth'
library.add(
  faArrowDownWideShort,
  faArrowUpWideShort,
  faSortUp,
  faSortDown,
  faBed,
  faShower,
  faSquareParking,
  faCircleInfo,
  faGlobe,
  faArrowUp,
  faArrowDown
)

const { listingColumnsData, listingColumnsArray, buildColumns, clearListingsColumns } = useListingColumnsAtom()
const { clearListings } = useListingsRawAtom()

const isLoading = ref(true)
const showAvailabilityOptions = ref(false)
const showPriceOptions = ref(false)
const currentSortOrder = ref<'low-to-high' | 'high-to-low' | null>(null)

const listingTableContainer = ref(null)

const router = useRouter()

// Define types for better TypeScript support
interface ColumnData {
  listing_data: {
    listing_id: number
    title: string
    thumbnail?: string
    is_online: boolean
    unit_number?: string
    street_address?: string
  }
  price: {
    visible: boolean
    rent_price?: number
    sale_price?: number
  }
  price_per_sqm: {
    visible: boolean
    rent_price_per_sqm?: number
    sale_price_per_sqm?: number
  }
  condition: {
    visible: boolean
    value: string
  }
  city: {
    visible: boolean
    value: string
  }
  availability: {
    visible: boolean
    value: string
  }
  designation: {
    visible: boolean
    value: string
  }
  contact: {
    visible: boolean
    name: string
    email: string
  }
  bedrooms: {
    visible: boolean
    value: number
  }
  bathrooms: {
    visible: boolean
    value: number
  }
  floor_area: {
    visible: boolean
    value: number
  }
  lot_area: {
    visible: boolean
    value: number
  }
  parking_spaces: {
    visible: boolean
    value: number
  }
  status: {
    visible: boolean
    label: string
    value: string
  }
  is_online: {
    visible: boolean
    value: boolean
  }
  updated_at: {
    visible: boolean
    value: string
  }
  uploaded_by: {
    visible: boolean
    value: string
  }
  category: {
    visible: boolean
    value: string
  }
}

interface TempListing {
  listing_id: number
  for: 'creation' | 'deletion' | 'update'
  [key: string]: any
}

const props = withDefaults(
  defineProps<{
    // Required for the redesigned /listings page; OPTIONAL with safe
    // defaults so the legacy /outdated, /deck, /featured-listings,
    // /archives pages — which still call <ListingsTable :table="..." />
    // with the pre-overhaul prop shape — keep rendering instead of
    // crashing on "missing required prop." The legacy pages will show
    // an empty table until they're migrated to the new prop API; better
    // than the blank page they were producing.
    columnsData?: ColumnData[]
    currentPage?: number
    currentCategory?: string
    currentAvailabilityType?: string
    itemsPerPage?: number
    // True when at least one filter (URL or modal) is non-default. Lets the
    // empty state swap between "no listings yet" + Create CTA and "no
    // matches" + Clear-filters CTA. Optional so existing callers keep working.
    hasActiveFilters?: boolean
    // Phase 2 bulk-selection props. Opt-in: when selectionEnabled is false
    // the checkbox column doesn't render, so other consumers of this table
    // (deck, archives, etc.) keep their old layout.
    selectionEnabled?: boolean
    isRowSelected?: (id: number) => boolean
  }>(),
  {
    columnsData: () => [],
    currentPage: 1,
    currentCategory: '',
    currentAvailabilityType: 'all',
    selectionEnabled: false,
  },
)

const emit = defineEmits<{
  sortingFunction: []
  toggleListingDetailsSidebar: [id: number]
  toggleOptionsMenu: []
  showUpdateListingForm: [id: number]
  dataProcessed: [data: ColumnData[]]
  toggleContactInfoModal: [contactId: number]
  showUpdateAvailabilityModal: [listingId: number, title: string, availability: string]
  getListings: []
  changeAvailabilityType: [type: string]
  triggerListingEnablement: [listingId: number]
  triggerStatusSwitch: [listingId: number]
  sortByPrice: [order: 'low-to-high' | 'high-to-low']
  // Empty-state CTAs — wired by the parent (index.vue) to its existing
  // resetFilters / showCreateListing handlers.
  clearFilters: []
  createListing: []
  // Phase 2 bulk-selection emits.
  toggleRow: [id: number]
  toggleAllOnPage: []
  // Per-row "History" — opens the change-history drawer in the parent.
  showHistory: [id: number]
  showRemarksModal: [payload: any]
  showDownloadModal: [payload: any]
  showPropertyLogs: [payload: any]
  resetListings: []
  showCloneListing: [payload: any]
}>()

const tempListings = ref<TempListing[]>([])

const onlineTooltip = ref<HTMLElement | null>(null)

function openContactInfo(contactId: number) {
  emit('toggleContactInfoModal', contactId)
}

function triggerListingEnablement(listingId: number) {
  console.log('triggerListingEnablement called for listing:', listingId)

  if (!can('view_all_listings')) {
    return
  }

  emit('triggerListingEnablement', listingId)
}

function triggerStatusSwitch(listingId: number) {
  console.log('triggerStatusSwitch called for listing:', listingId)
  emit('triggerStatusSwitch', listingId)
}

function getListings() {
  console.log('getListings from Table')
  emit('getListings')
}

function toggleAvailabilityOptions() {
  showAvailabilityOptions.value = !showAvailabilityOptions.value
}

function togglePriceOptions() {
  showPriceOptions.value = !showPriceOptions.value
}

function sortByPrice(order: 'low-to-high' | 'high-to-low') {
  currentSortOrder.value = order
  emit('sortByPrice', order)
  showPriceOptions.value = false
}

function openUpdateAvailabilityModal(
  listingId: number,
  title: string,
  availability: string
) {
  console.log('listingId: ', listingId)
  console.log('title: ', title)
  console.log('availability: ', availability)
  emit('showUpdateAvailabilityModal', listingId, title, availability)
}

const updateListingImmediately = (listingId: number, updates: any) => {
  console.log('Updating listing immediately:', listingId, updates)

  // Find the column in the displayed data
  const columnIndex = props.columnsData.findIndex(
    (col: ColumnData) => col.listing_data.listing_id === listingId
  )

  if (columnIndex !== -1) {
    const column = props.columnsData[columnIndex]

    // Update all relevant fields
    if (updates.is_online !== undefined) {
      column.is_online.value = updates.is_online
    }
    if (updates.availability_date !== undefined) {
      column.availability.value = updates.availability_date
    }
    if (updates.title !== undefined) {
      column.listing_data.title = updates.title
    }
    if (updates.status !== undefined) {
      column.status.value = updates.status
    }
    if (updates.condition !== undefined) {
      column.condition.value = updates.condition
    }
    if (updates.unit_number !== undefined) {
      column.listing_data.unit_number = updates.unit_number
    }
    if (updates.sale_price !== undefined) {
      column.price.sale_price = updates.sale_price
    }
    if (updates.rent_price !== undefined) {
      column.price.rent_price = updates.rent_price
    }
    if (updates.sale_price_per_sqm !== undefined) {
      column.price_per_sqm.sale_price_per_sqm = updates.sale_price_per_sqm
    }
    if (updates.rent_price_per_sqm !== undefined) {
      column.price_per_sqm.rent_price_per_sqm = updates.rent_price_per_sqm
    }
    if (updates.bedrooms !== undefined) {
      column.bedrooms.value = updates.bedrooms
    }
    if (updates.bathrooms !== undefined) {
      column.bathrooms.value = updates.bathrooms
    }
    if (updates.floor_area !== undefined) {
      column.floor_area.value = updates.floor_area
    }
    if (updates.lot_area !== undefined) {
      column.lot_area.value = updates.lot_area
    }
    if (updates.parking_spaces !== undefined) {
      column.parking_spaces.value = updates.parking_spaces
    }

    console.log('Updated column:', column)
  }
}

const checkIfListingIsForUpdate = (listingId: number) => {
  const tempListing = tempListings.value.find(
    tempListing => tempListing.listing_id === listingId && tempListing.for === 'update'
  )

  if (tempListing) {
    console.log('Found temp listing for update:', tempListing)
    updateListingImmediately(listingId, tempListing)
  }

  return !!tempListing
}

const checkIfListingIsForDeletion = (listingId: number) => {
  return tempListings.value.some(
    (tempListing) =>
      tempListing.listing_id === listingId && tempListing.for === 'deletion'
  )
}

const visibleColumns = computed(() => {
  return listingColumnsArray
    .filter((col) => col.visible)
    .map((col) => col.column_name)
})

const visibleColumnsWithIcons = computed(() => {
  return listingColumnsArray
    .filter((col) => col.visible)
    .map((col) => ({
      name: col.column_name,
      column_name: col.column_name,
      icon: col.icon || null
    }))
})
function applySortToData(data: ColumnData[], sortOrder: 'low-to-high' | 'high-to-low' | null): ColumnData[] {
  if (!sortOrder) {
    return data
  }

  const sorted = [...data].sort((a, b) => {
    const aPrice = a.price.rent_price ?? a.price.sale_price ?? 0
    const bPrice = b.price.rent_price ?? b.price.sale_price ?? 0

    if (sortOrder === 'low-to-high') {
      return aPrice - bPrice
    } else {
      return bPrice - aPrice
    }
  })

  return sorted
}

const displayedColumnsData = computed(() => {
  if (!props.columnsData || !Array.isArray(props.columnsData)) {
    return []
  }

  // Filter data by category first
  const categoryFilteredData = props.columnsData.filter(
    (col) => col?.category?.value === props.currentCategory
  )

  console.log('categoryFilteredData: ', categoryFilteredData)

  // Apply sorting if a sort order is set
  const sortedData = applySortToData(categoryFilteredData, currentSortOrder.value)

  // Calculate pagination slice
  const itemsPerPage = props.itemsPerPage || 5
  const start = (props.currentPage - 1) * itemsPerPage
  const end = start + itemsPerPage

  return sortedData.slice(start, end)
})

// Bulk-select helpers driving the header checkbox tri-state.
// "All on page" only refers to the rows currently visible (the slice
// rendered above), so paging forward doesn't carry indeterminate state.
const visibleListingIds = computed<number[]>(() =>
  displayedColumnsData.value.map((c: any) => c.listing_data?.listing_id).filter(Boolean),
)

const allOnPageSelected = computed(() => {
  if (!props.selectionEnabled || !props.isRowSelected) return false
  if (visibleListingIds.value.length === 0) return false
  return visibleListingIds.value.every((id) => props.isRowSelected!(id))
})

const someOnPageSelected = computed(() => {
  if (!props.selectionEnabled || !props.isRowSelected) return false
  return visibleListingIds.value.some((id) => props.isRowSelected!(id))
})

const totalItems = computed(() => {
  if (!props.columnsData || !Array.isArray(props.columnsData)) {
    return 0
  }
  return props.columnsData.filter(
    (col) => col?.category?.value === props.currentCategory
  ).length
})

const totalPages = computed(() => {
  const itemsPerPage = props.itemsPerPage || 5
  return Math.ceil(totalItems.value / itemsPerPage)
})

const processColumnsData = async () => {
  try {
    isLoading.value = true

    if (!props.columnsData || !Array.isArray(props.columnsData)) {
      emit('dataProcessed', [])
      return
    }

    // Filter data by category first
    const categoryFilteredData = props.columnsData.filter(
      (col) => col?.category?.value === props.currentCategory && col?.visible
    )

    // // Then filter and map visible columns
    // const visibleData = categoryFilteredData
    //   .map((col) => {
    //     if (!col) return null

    //     const filtered = Object.entries(col).filter(
    //       ([_, value]) =>
    //         value &&
    //         typeof value === 'object' &&
    //         'column_name' in value &&
    //         visibleColumns.value.includes(value.column_name)
    //     )

    //     return filtered.length > 0 ? Object.fromEntries(filtered) : null
    //   })
    //   .filter(Boolean)

    // displayedColumnsData.value = visibleData
    emit('dataProcessed', categoryFilteredData)
  } catch (error) {
    console.error('Error processing columns data:', error)
    emit('dataProcessed', [])
  } finally {
    isLoading.value = false
  }
}

function showUpdateListing(listingData: any) {
  // Toggle NewForm.vue to update a listing
  emit('showUpdateListingForm', listingData.listing_id)
}

function showRemarksModal(payload: any) {
  emit('showRemarksModal', payload)
}

function showDownloadModal(payload: any) {
  emit('showDownloadModal', payload)
}

function showPropertyLogs(payload: any) {
  emit('showPropertyLogs', payload)
}

function resetListings() {
  emit('resetListings')
}

function showCloneListing(payload: any) {
  emit('showCloneListing', payload)
}

watch(
  [
    () => props.columnsData,
    () => props.currentPage,
    () => props.currentCategory,
    () => listingColumnsArray,
  ],
  async ([newData, newPage, newCategory], [oldData, oldPage, oldCategory]) => {
    // Process data if any of these conditions are met:
    // 1. Data content changed
    // 2. Page changed
    // 3. Category changed
    // 4. Columns changed
    if (
      JSON.stringify(newData) !== JSON.stringify(oldData) ||
      newPage !== oldPage ||
      newCategory !== oldCategory
    ) {
      await processColumnsData()
    }
  },
  { deep: true, immediate: true }
)

// Add this function to check localStorage on mount and when props change
const checkLocalStorageUpdates = () => {
  const existingKeys = Object.keys(localStorage)
    .filter(key => key.startsWith('tempListing-'))
    .map(key => ({
      key,
      value: JSON.parse(localStorage.getItem(key))
    }))

  tempListings.value = existingKeys.map(k => k.value)

  // If we have updates, trigger a rebuild of the columns
  if (existingKeys.length > 0) {
    emit('getListings')
  }
}

// Watch for changes in the displayed data
watch(() => props.columnsData, () => {
  checkLocalStorageUpdates()
}, { deep: true })

// Reset sort order when category changes
watch(() => props.currentCategory, () => {
  currentSortOrder.value = null
})

// Check localStorage on mount
onMounted(() => {
  checkLocalStorageUpdates()
})

onMounted(async () => {
  console.log('listingColumnsData from Table.vue: ', listingColumnsData)

  if (props.columnsData && props.columnsData.length > 0) {
    isLoading.value = true
    try {
      await processColumnsData()
    } finally {
      isLoading.value = false
    }
  }

  // Set responsive width constraints
  if (listingTableContainer.value) {
    listingTableContainer.value.style.width = '100%'
  }
  // listingTableContainer.value!.style.height = '100vw'

  // Add click outside handler for dropdowns
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as HTMLElement

  // Check if click is outside availability dropdown
  if (showAvailabilityOptions.value && !target.closest('.availability-dropdown-container')) {
    showAvailabilityOptions.value = false
  }

  // Check if click is outside price dropdown
  if (showPriceOptions.value && !target.closest('.price-dropdown-container')) {
    showPriceOptions.value = false
  }
}

onNuxtReady(() => {
  console.log('from Table.vue: ', listingColumnsData)
})

function toggleListingDetailsSidebar(colId: number) {
  console.log('colId: ', colId)
  emit('toggleListingDetailsSidebar', colId)
}

const hasData = computed(() => {
  return props.columnsData && props.columnsData.length > 0
})

const getClass = (index: string) => {
  let classes = ''

  classes =
    index == 'name'
      ? 'rounded-r-2xl rounded-l-2xl sm:rounded-r-none md:rounded-r-none lg:rounded-r-none pl-6'
      : ''

  classes += index == 'notes' ? ' w-1/3' : ''

  let small = [
    'formatted_price',
    'amenities',
    'availability',
    'actions',
    'price',
    'user_name',
    'name',
    'designation',
    'email',
    'homephone',
  ]
  let responsive = [
    'city_name.keyword',
    'user_name',
    'uploader.name',
    'last_updated',
    'fblink',
    'area',
    'city',
  ]

  if (responsive.includes(index)) {
    classes += 'hidden sm:hidden md:hidden lg:table-cell'
  }

  if (small.includes(index)) {
    classes += 'hidden sm:table-cell md:table-cell lg:table-cell'
  }

  classes +=
    index == 'availability' ? ' sm:hidden md:table-cell lg:table-cell' : ''

  classes += index == 'actions' ? ' rounded-r-2xl pr-6' : ''

  return classes
}

// Add a watcher for localStorage changes
onMounted(() => {
  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith('tempListing-')) {
      const listingId = parseInt(event.key.replace('tempListing-', ''))
      const updates = JSON.parse(event.newValue || '{}')
      if (updates.for === 'update') {
        console.log('Storage event received for update:', updates)
        updateListingImmediately(listingId, updates)
      }
    }
  })

  // Listen for custom listing-updated events
  window.addEventListener('listing-updated', ((event: CustomEvent) => {
    const { listingId, updates } = event.detail
    console.log('Custom event received for update:', listingId, updates)
    updateListingImmediately(listingId, updates)
  }) as EventListener)
})

// Update the getRowClasses function to remove the green background
function getRowClasses(columnData: any) {
  const classes = [
    'relative transition-colors duration-200 z-[1]',
    checkIfListingIsForDeletion(columnData.listing_data.listing_id)
      ? 'bg-destructive/15 hover:bg-destructive/25'
      : 'hover:bg-accent hover:text-accent-foreground'
  ]

  return classes
}
</script>

<style scoped>
.material-design-icon svg {
  width: 17px;
  height: 17px;
}

.pagination-navs a:first-child {
  border-top-left-radius: 0.375rem;
  border-bottom-left-radius: 0.375rem;
}

.pagination-navs a:last-child {
  border-top-right-radius: 0.375rem;
  border-bottom-right-radius: 0.375rem;
}

.tooltip {
  @apply invisible absolute;
}

.has-tooltip:hover .tooltip {
  @apply visible z-50;
}
</style>
