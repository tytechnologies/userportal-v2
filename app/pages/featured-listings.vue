<template>
  <AdminPageShell :permission="false" max-width="wide">
    <UiPageHeader
      title="Featured Listings"
      description="Manage featured listings on the website homepage. Drag the handle to reorder; preview on the right reflects what visitors see."
    />

    <div class="grid gap-4 lg:grid-cols-[1fr_2fr]">
      <!-- Sidebar: editor -->
      <UiCard padding="md">
        <p class="mb-3 text-meta">
          💡 Drag the <span class="font-mono font-semibold">⋮⋮</span> handle to reorder.
        </p>

        <div class="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
            @click="addProperty"
          >
            Add Listing
          </button>
          <button
            type="button"
            class="rounded-lg px-4 py-2 text-sm font-semibold transition-colors duration-150 ease-out focus-ring"
            :class="hasOrderChanged
              ? 'bg-success text-success-foreground hover:bg-success/90 animate-pulse'
              : 'bg-success/80 text-success-foreground hover:bg-success/90'"
            @click="saveChanges"
          >
            {{ hasOrderChanged ? 'Save Changes*' : 'Save Changes' }}
          </button>
        </div>

        <div
          id="properties-container"
          class="max-h-[60vh] overflow-y-auto border-t border-border pt-4"
        >
          <div
            v-for="(property, index) in featuredListings"
            :key="property.id"
            class="mb-3 cursor-move rounded-lg p-2 transition-colors duration-150 ease-out"
            :class="{
              'bg-primary/10': highlightedPropertyId === property.id,
              'bg-muted': isDragging && draggedIndex === index,
              'border-2 border-dashed border-primary': isDragging && draggedIndex === index,
            }"
            draggable="true"
            @dragstart="handleDragStart(index, $event)"
            @dragover.prevent
            @dragenter="handleDragEnter(index, $event)"
            @dragleave="handleDragLeave(index, $event)"
            @drop="handleDrop(index, $event)"
            @dragend="handleDragEnd"
            @mouseover="highlightedPropertyId = property.id"
            @mouseleave="highlightedPropertyId = null"
          >
            <div class="flex items-end gap-2">
              <div class="w-12 shrink-0">
                <Input readonly type="text" :model-value="index + 1">No.</Input>
              </div>
              <div
                class="drag-handle flex shrink-0 cursor-move items-center"
                aria-label="Drag handle"
                @mousedown="handleDragStart(index, $event)"
              >
                <svg
                  class="h-4 w-4 text-muted-foreground/70"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path
                    d="M7 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 2zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 14zm6-8a2 2 0 1 1-.001-4.001A2 2 0 0 1 13 6zm0 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 14z"
                  />
                </svg>
              </div>
              <VSelect
                :model-value="property.listing_id"
                :options="availableProperties"
                :otherSelectOpened="activeDropdown !== property.id"
                @onChange="(value) => updateProperty(value, index)"
                @openSelectEvent="handleDropdownOpen(property.id)"
              >
                Property Title
              </VSelect>
              <button
                type="button"
                class="h-10 shrink-0 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground transition-colors duration-150 ease-out hover:bg-destructive/90 focus-ring"
                @click="removeProperty(index)"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      </UiCard>

      <!-- Preview -->
      <UiCard padding="md">
        <h2 class="mb-3 text-card-title">Preview</h2>
        <div class="w-full rounded-lg bg-muted/50 p-4">
          <Splide v-if="featuredListings.length > 0" :options="splideOptions">
            <SplideSlide
              v-for="property in featuredListings"
              :key="property.id"
              class="p-2"
              @mouseover="highlightedPropertyId = property.id"
              @mouseleave="highlightedPropertyId = null"
            >
              <FeaturedListingCard
                :property="property"
                :preloaded-thumbnail="thumbnailMap.get(property.listing_id)"
                class="h-[400px] rounded-lg border-2 transition-colors duration-150 ease-out"
                :class="highlightedPropertyId === property.id
                  ? 'border-primary'
                  : 'border-transparent'"
              />
            </SplideSlide>
          </Splide>
          <div
            v-else
            class="flex h-[400px] items-center justify-center rounded-lg"
          >
            <span class="text-meta">No featured listings to preview.</span>
          </div>
        </div>
      </UiCard>
    </div>
  </AdminPageShell>
</template>

<script setup>
import { ref, onMounted, reactive, nextTick, computed } from 'vue'
import Input from '~/components/Input.vue'
import VSelect from '~/components/VSelectFeatured.vue'
import FeaturedListingCard from '~/components/pages/listings/FeaturedListingCard.vue'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import { v4 as uuidv4 } from 'uuid'
import { Splide, SplideSlide } from '@splidejs/vue-splide'
import '@splidejs/vue-splide/css'
import { useThumbnailCache } from '~/composables/useThumbnailCache'
import thumbnailCache from '~/services/images/thumbnailCache'
import { useThumbnailStore } from '~/store/thumbnailStore'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'

const availableProperties = ref([])
const featuredListings = ref([])
const initialFeaturedListings = ref([])
const activeDropdown = ref(null)
const highlightedPropertyId = ref(null)
const thumbnailMap = ref(new Map()) // Store preloaded thumbnails

// Drag and drop state
const isDragging = ref(false)
const draggedIndex = ref(-1)
const draggedItem = ref(null)
const dropTargetIndex = ref(-1)

const supabase = useSupabaseClient()
const { preloadThumbnails, getCacheStats } = useThumbnailCache()
const thumbnailStore = useThumbnailStore()

// Computed property to check if order has changed
const hasOrderChanged = computed(() => {
  if (initialFeaturedListings.value.length !== featuredListings.value.length) {
    return true
  }

  for (let i = 0; i < featuredListings.value.length; i++) {
    const current = featuredListings.value[i]
    const initial = initialFeaturedListings.value[i]

    if (!current || !initial || current.listing_id !== initial.listing_id) {
      return true
    }
  }

  return false
})

const splideOptions = {
  type: 'loop',
  perPage: 3,
  perMove: 1,
  gap: '1rem',
  focus: 'center',
  pagination: false,
  breakpoints: {
    1024: {
      perPage: 2,
    },
    768: {
      perPage: 1,
    },
  },
}

async function fetchAllListings() {
  // listing_details.listing_id is the PK; no remap needed (the old
  // `listing_id: listing.id` was a no-op since `id` doesn't exist on
  // the MV).
  const { data, error } = await supabase
    .from('listing_details')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Error fetching listing details:', error)
    return
  }

  availableProperties.value = (data ?? []).map((listing) => ({
    ...listing,
    value: listing.listing_id,
    label: `ID ${listing.listing_id} - ${listing.title}`,
    address: listing.street_address,
  }))
}

async function fetchFeaturedListings() {
  showLoading()

  // Two-step hydrate:
  //   1. featured_listings → ordered list of (listing_id, position)
  //   2. listing_details → rich row data for those ids
  // PostgREST embed (featured_listings → listings) doesn't reach
  // listing_details (the MV has no FK), so we join in JS. The MV's
  // is_featured column would let us skip step 1, but position lives
  // only on featured_listings so we still need both reads.
  const { data: positions, error: posError } = await supabase
    .from('featured_listings')
    .select('listing_id, position')
    .order('position', { ascending: true })

  if (posError) {
    console.error('Error fetching featured_listings:', posError)
    dismissLoading()
    return
  }

  const ids = (positions ?? []).map((p) => p.listing_id).filter(Boolean)

  let detailsById = new Map()
  if (ids.length > 0) {
    const { data: details, error: detError } = await supabase
      .from('listing_details')
      .select('*')
      .in('listing_id', ids)
    if (detError) {
      console.error('Error fetching listing_details for featured ids:', detError)
      dismissLoading()
      return
    }
    detailsById = new Map((details ?? []).map((d) => [d.listing_id, d]))
  }

  // Preserve featured_listings order (position ASC); rows whose
  // listing_details row is missing (e.g. soft-deleted listing) are
  // dropped rather than rendered as blank cards.
  const listings = (positions ?? [])
    .map((p) => {
      const detail = detailsById.get(p.listing_id)
      if (!detail) return null
      return {
        ...detail,
        listing_id: p.listing_id,
        position: p.position,
        id: uuidv4(),
      }
    })
    .filter((row) => row !== null)

  featuredListings.value = [...listings]
  initialFeaturedListings.value = [...listings]

  // Preload thumbnails using the store (more persistent)
  if (listings.length > 0) {
    console.log('Preloading thumbnails for featured listings via store...')
    await thumbnailStore.preloadThumbnails(listings)

    // Populate thumbnail map with preloaded thumbnails from store
    for (const listing of listings) {
      if (listing.listing_id) {
        const storeUrl = thumbnailStore.getThumbnailUrl(listing.listing_id)
        if (storeUrl) {
          thumbnailMap.value.set(listing.listing_id, storeUrl)
        }
      }
    }
    console.log(
      'Thumbnail map populated with',
      thumbnailMap.value.size,
      'thumbnails'
    )
  }

  dismissLoading()
}

function handleDropdownOpen(dropdownId) {
  activeDropdown.value = dropdownId
}

function addProperty() {
  featuredListings.value.push({
    id: uuidv4(),
    listing_id: null,
    title: null,
    condition: null,
    street_address: null,
    city_name: null,
    floor_area: null,
    lot_area: null,
    bedrooms: null,
    bathrooms: null,
    rent_price: null,
    sale_price: null,
    parking_spaces: null,
  })

  console.log('featuredListings: ', featuredListings.value)
  nextTick(() => {
    const container = document.querySelector('#properties-container')
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  })
}

function removeProperty(index) {
  featuredListings.value.splice(index, 1)
}

function updateProperty(selected, index) {
  // Match by listing_id — the MV's PK column. Earlier code looked up
  // by `p.id`, which doesn't exist on listing_details rows.
  const fullProperty = availableProperties.value.find(
    (p) => p.listing_id === selected.value,
  )
  if (!fullProperty) return

  featuredListings.value[index] = {
    ...fullProperty,
    listing_id: fullProperty.listing_id,
    // Preserve the per-row UUID used as Vue's `:key` so the carousel
    // doesn't re-mount.
    id: featuredListings.value[index].id,
  }

  thumbnailStore.fetchThumbnail(fullProperty.listing_id).then((url) => {
    if (url) thumbnailMap.value.set(fullProperty.listing_id, url)
  })
}

// Drag and drop handlers
function handleDragStart(index, event) {
  isDragging.value = true
  draggedIndex.value = index
  draggedItem.value = featuredListings.value[index]

  // Add dragging class to the dragged element
  event.target.closest('.mb-4').classList.add('dragging')

  // Set drag image (optional - makes the drag preview smaller)
  const dragImage = event.target.cloneNode(true)
  dragImage.style.opacity = '0.5'
  dragImage.style.transform = 'scale(0.8)'
  event.dataTransfer.setDragImage(dragImage, 0, 0)

  // Set drag data
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', index.toString())

  console.log('Drag started for index:', index)
}

function handleDragEnter(index, event) {
  event.preventDefault()
  if (index !== draggedIndex.value) {
    dropTargetIndex.value = index
    // Add drag-over class to the target element
    event.currentTarget.classList.add('drag-over')
    console.log('Drag enter target index:', index)
  }
}

function handleDragLeave(index, event) {
  event.preventDefault()
  // Only clear if we're leaving the actual target, not entering a child element
  if (!event.currentTarget.contains(event.relatedTarget)) {
    dropTargetIndex.value = -1
    // Remove drag-over class
    event.currentTarget.classList.remove('drag-over')
  }
}

function handleDrop(index, event) {
  event.preventDefault()

  // Remove drag-over class
  event.currentTarget.classList.remove('drag-over')

  if (draggedIndex.value === -1 || draggedIndex.value === index) {
    return
  }

  console.log(
    `Dropping item from index ${draggedIndex.value} to index ${index}`
  )

  // Reorder the array
  const newListings = [...featuredListings.value]
  const draggedItem = newListings[draggedIndex.value]

  // Remove the dragged item
  newListings.splice(draggedIndex.value, 1)

  // Insert at the new position
  newListings.splice(index, 0, draggedItem)

  // Update the featured listings
  featuredListings.value = newListings

  console.log(
    'Listings reordered:',
    newListings.map((l) => l.listing_id)
  )

  // Reset drag state
  resetDragState()
}

function handleDragEnd() {
  resetDragState()
}

function resetDragState() {
  isDragging.value = false
  draggedIndex.value = -1
  draggedItem.value = null
  dropTargetIndex.value = -1

  // Remove all drag-related classes from all elements
  document.querySelectorAll('.dragging, .drag-over').forEach((el) => {
    el.classList.remove('dragging', 'drag-over')
  })
}

async function saveChanges() {
  showLoading()

  const initialIds = initialFeaturedListings.value.map((p) => p.listing_id)
  const currentIds = featuredListings.value
    .map((p) => p.listing_id)
    .filter(Boolean)

  const toAdd = featuredListings.value.filter(
    (p) => p.listing_id && !initialIds.includes(p.listing_id)
  )
  const toRemove = initialFeaturedListings.value.filter(
    (p) => !currentIds.includes(p.listing_id)
  )
  const toUpdate = featuredListings.value.filter(
    (p) => p.listing_id && initialIds.includes(p.listing_id)
  )

  const promises = []

  // Add new featured listings
  toAdd.forEach((property) => {
    const position = featuredListings.value.findIndex(
      (p) => p.listing_id === property.listing_id
    )
    promises.push(
      supabase
        .from('featured_listings')
        .insert({
          listing_id: property.listing_id,
          position: position
        })
    )
  })

  // Update positions for existing featured listings
  toUpdate.forEach((property) => {
    const position = featuredListings.value.findIndex(
      (p) => p.listing_id === property.listing_id
    )
    const initialProperty = initialFeaturedListings.value.find(
      (p) => p.listing_id === property.listing_id
    )
    if (initialProperty.position !== position) {
      promises.push(
        supabase
          .from('featured_listings')
          .update({ position })
          .eq('listing_id', property.listing_id)
      )
    }
  })

  // Remove featured listings
  toRemove.forEach((property) => {
    promises.push(
      supabase
        .from('featured_listings')
        .delete()
        .eq('listing_id', property.listing_id)
    )
  })

  const results = await Promise.all(promises)

  dismissLoading()

  const hasError = results.some((res) => res.error)
  if (hasError) {
    showToast({
      title: 'Error saving changes. Check console for details.',
      icon: 'error',
    })
    console.error(
      'Error saving changes:',
      results.map((r) => r.error)
    )
  } else {
    showToast({
      title: 'Featured listings updated successfully!',
      icon: 'success',
    })
    fetchFeaturedListings() // Refresh the list
  }
}

onMounted(async () => {
  await fetchAllListings()
  await fetchFeaturedListings()
})
</script>

<style>
/* It's better to scope styles, but for Splide overrides global might be needed */
.splide__arrow {
  background-color: #3b82f6;
  /* blue-500 */
  color: white;
}

.splide__arrow:hover {
  background-color: #2563eb;
  /* blue-600 */
}

.transition-all {
  transition: all 0.3s ease;
}

/* Drag and drop styles */
.dragging {
  opacity: 0.5;
  transform: rotate(5deg);
  z-index: 1000;
}

.drag-over {
  background-color: #dbeafe !important;
  /* blue-100 */
  border: 2px dashed #3b82f6 !important;
  /* blue-500 */
  transform: scale(1.02);
}

.drag-handle {
  cursor: grab;
}

.drag-handle:active {
  cursor: grabbing;
}

/* Smooth transitions for drag feedback */
.mb-4.items-center.p-2.rounded-lg {
  transition: all 0.2s ease;
}
</style>
