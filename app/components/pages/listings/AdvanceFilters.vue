<style>
.form-input {
  @apply w-full h-10 leading-9 block border bg-muted/50 border-border focus:bg-transparent rounded-lg text-sm font-bold px-3 pt-1 pb-0 placeholder-gray-3 text-foreground border border-solid focus-within:border-blue;
}
</style>

<template>
  <!-- Advanced Filter — Phase 7 Operations primitive -->
  <UiModal
    :open="advancedFiltersSidebarOpen"
    title="Advanced Filter"
    width="xl"
    @update:open="(v) => { if (!v) $emit('toggleAdvancedFiltersSidebar') }"
  >
    <!-- Three Column Grid -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">

              <!-- Column 1: Category, Type, Condition, Parking -->
              <div class="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                <!-- For (Category) -->
                <div>
                  <h3 class="text-sm mb-2 font-semibold text-foreground bg-muted rounded-lg px-3 py-2">
                    For
                  </h3>
                  <div class="flex">
                    <div v-for="forx in availableFilters.fors" :key="forx.id"
                      class="flex items-center cursor-pointer p-2 rounded-lg"
                      :class="{ 'bg-primary/10': form.forId === forx.id }" @click="form.forId = forx.id">
                      <input type="radio" name="for" :value="forx.id" v-model="form.forId"
                        class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring" />
                      <label class="ml-2 text-sm font-medium text-foreground cursor-pointer">{{
                        forx.name
                      }}</label>
                    </div>
                  </div>
                </div>

                <!-- Type -->
                <div>
                  <h3 class="text-sm mb-2 font-semibold text-foreground bg-muted rounded-lg px-3 py-2">
                    Type
                  </h3>
                  <div class="flex flex-wrap gap-2">
                    <div v-for="type in filteredPropertyTypes" :key="type.id"
                      class="flex items-center cursor-pointer p-2 rounded-lg"
                      :class="{ 'bg-primary/10': form.typeId === type.id }" @click="form.typeId = type.id">
                      <input type="radio" name="type" :value="type.id" v-model="form.typeId"
                        class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring" />
                      <label class="ml-2 text-sm font-medium text-foreground cursor-pointer">{{
                        type.name
                      }}</label>
                    </div>
                  </div>
                </div>

                <!-- Condition -->
                <div>
                  <h3 class="text-sm mb-2 font-semibold text-foreground bg-muted rounded-lg px-3 py-2">
                    Condition
                  </h3>
                  <div class="flex flex-wrap">
                    <div v-for="condition in availableFilters.conditions" :key="condition.id"
                      class="flex items-center cursor-pointer p-2 rounded-lg"
                      :class="{ 'bg-primary/10': form.conditionId === condition.id }"
                      @click="form.conditionId = condition.id">
                      <input type="radio" name="condition" :value="condition.id" v-model="form.conditionId"
                        class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring" />
                      <label class="ml-2 text-sm font-medium text-foreground cursor-pointer">{{
                        condition.name
                      }}</label>
                    </div>
                  </div>
                </div>

                <!-- Parking -->
                <div>
                  <Input id="parking" :model-value="form.parking" @change="
                    (value: string) => {
                      form.parking = String(value).replace(/[^0-9]/g, '')
                    }
                  " type="number">Parking Spots</Input>
                </div>
              </div>

              <!-- Column 2: Location, Availability, Bedroom, Bathroom -->
              <div class="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                <!-- Location -->
                <div class="relative">
                  <h3 class="text-sm mb-2 font-semibold text-foreground">
                    Location
                  </h3>
                  <input type="text" v-model="locationSearch" @input="handleLocationInput"
                    @focus="showLocationSuggestions = true" @blur="handleLocationBlur" class="form-input w-full"
                    placeholder="Type to search location or building..." />

                  <!-- Loading indicator -->
                  <div v-if="isSearchingLocations"
                    class="absolute z-50 w-full mt-1 bg-card border border-border rounded-lg shadow-lg p-3">
                    <p class="text-sm text-muted-foreground text-center">Searching...</p>
                  </div>

                  <!-- Suggestions Dropdown -->
                  <div v-else-if="showLocationSuggestions && filteredLocations.length > 0"
                    class="absolute z-50 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                    <div v-for="(suggestion, index) in filteredLocations" :key="`suggestion-${index}`"
                      @mousedown.prevent="selectLocation(suggestion)"
                      class="px-4 py-2 cursor-pointer hover:bg-primary/10 border-b border-border last:border-b-0">
                      <div class="text-sm font-medium text-foreground">{{ suggestion.name }}</div>
                      <div v-if="suggestion.description" class="text-xs text-muted-foreground mt-1">
                        {{ suggestion.description }}
                      </div>
                    </div>
                  </div>

                  <!-- No results message -->
                  <div
                    v-else-if="showLocationSuggestions && locationSearch && locationSearch.length > 2 && filteredLocations.length === 0 && !isSearchingLocations"
                    class="absolute z-50 w-full mt-1 bg-card border border-border rounded-lg shadow-lg p-3">
                    <p class="text-sm text-muted-foreground text-center">No locations found</p>
                  </div>
                </div>

                <!-- Availability -->
                <div>
                  <label class="text-sm font-bold text-foreground mb-2 block">Availability</label>
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label class="text-xs font-semibold text-foreground mb-1 block" for="availabilityFrom">
                        From
                      </label>
                      <input type="date" class="form-input" v-model="form.availabilityFrom" />
                    </div>
                    <div>
                      <label class="text-xs font-semibold text-foreground mb-1 block" for="availabilityTo">
                        To
                      </label>
                      <input type="date" class="form-input" v-model="form.availabilityTo" />
                    </div>
                    <span class="col-span-2 text-destructive text-xs" v-if="form.availabilityFrom > form.availabilityTo">
                      From date cannot be greater than To date
                    </span>
                  </div>
                </div>

                <!-- Bedroom -->
                <div>
                  <label class="text-sm font-bold text-foreground mb-2 block">Bedroom</label>
                  <div class="grid grid-cols-2 gap-2">
                    <Input id="min_bedroom" :model-value="form.minBedroom"
                      @change="(value: string) => { form.minBedroom = value }" :placeholder="1" type="number"
                      tooltip="Min Bedroom">Min</Input>
                    <Input id="max_bedroom" :model-value="form.maxBedroom"
                      @change="(value: string) => { form.maxBedroom = value }" :placeholder="5" type="number"
                      tooltip="Max Bedroom">Max</Input>
                    <span class="col-span-2 text-destructive text-xs"
                      v-if="form.minBedroom && form.maxBedroom && parseInt(form.minBedroom) > parseInt(form.maxBedroom)">
                      Min cannot be greater than Max
                    </span>
                  </div>
                </div>

                <!-- Bathroom -->
                <div>
                  <label class="text-sm font-bold text-foreground mb-2 block">Bathroom</label>
                  <div class="grid grid-cols-2 gap-2">
                    <Input id="min_bathroom" :model-value="form.minBathroom"
                      @change="(value: string) => { form.minBathroom = value }" :placeholder="1" type="number"
                      tooltip="Min Bathroom">Min</Input>
                    <Input id="max_bathroom" :model-value="form.maxBathroom"
                      @change="(value: string) => { form.maxBathroom = value }" :placeholder="3" type="number"
                      tooltip="Max Bathroom">Max</Input>
                    <span class="col-span-2 text-destructive text-xs"
                      v-if="form.minBathroom && form.maxBathroom && parseInt(form.minBathroom) > parseInt(form.maxBathroom)">
                      Min cannot be greater than Max
                    </span>
                  </div>
                </div>
              </div>

              <!-- Column 3: Price, Price Per Sqm, Floor Area, Plot Area -->
              <div class="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                <!-- Price -->
                <div>
                  <label class="text-sm font-bold text-foreground mb-2 block">Price</label>
                  <div class="grid grid-cols-2 gap-2">
                    <Input id="min_price" for-currency :model-value="form.minPrice"
                      @change="(value: string) => { form.minPrice = value }" :placeholder="10000"
                      tooltip="Min Price">Min</Input>
                    <Input id="max_price" for-currency :model-value="form.maxPrice"
                      @change="(value: string) => { form.maxPrice = value }" :placeholder="15000"
                      tooltip="Max Price">Max</Input>
                    <span class="col-span-2 text-destructive text-xs"
                      v-if="form.minPrice && form.maxPrice && parseInt(form.minPrice) > parseInt(form.maxPrice)">
                      Min cannot be greater than Max
                    </span>
                  </div>
                </div>

                <!-- Price Per Sqm -->
                <div>
                  <label class="text-sm font-bold text-foreground mb-2 block">Price Per Sqm</label>
                  <div class="grid grid-cols-2 gap-2">
                    <Input id="min_pps" :model-value="form.minPps" @change="(value: string) => { form.minPps = value }"
                      :placeholder="100" type="number" tooltip="Min Price Per Sqm">Min</Input>
                    <Input id="max_pps" :model-value="form.maxPps" @change="(value: string) => { form.maxPps = value }"
                      :placeholder="155" type="number" tooltip="Max Price Per Sqm">Max</Input>
                    <span class="col-span-2 text-destructive text-xs"
                      v-if="form.minPps && form.maxPps && parseInt(form.minPps) > parseInt(form.maxPps)">
                      Min cannot be greater than Max
                    </span>
                  </div>
                </div>

                <!-- Floor Area -->
                <div>
                  <label class="text-sm font-bold text-foreground mb-2 block">Floor Area (sqm)</label>
                  <div class="grid grid-cols-2 gap-2">
                    <Input id="min_floor_area" :model-value="form.minFloorArea"
                      @change="(value: string) => { form.minFloorArea = value }" :placeholder="50" type="number"
                      tooltip="Min Floor Area">Min</Input>
                    <Input id="max_floor_area" :model-value="form.maxFloorArea"
                      @change="(value: string) => { form.maxFloorArea = value }" :placeholder="200" type="number"
                      tooltip="Max Floor Area">Max</Input>
                    <span class="col-span-2 text-destructive text-xs"
                      v-if="form.minFloorArea && form.maxFloorArea && parseInt(form.minFloorArea) > parseInt(form.maxFloorArea)">
                      Min cannot be greater than Max
                    </span>
                  </div>
                </div>

                <!-- Plot Area -->
                <div>
                  <label class="text-sm font-bold text-foreground mb-2 block">Plot Area (sqm)</label>
                  <div class="grid grid-cols-2 gap-2">
                    <Input id="min_lot_area" :model-value="form.minLotArea"
                      @change="(value: string) => { form.minLotArea = value }" :placeholder="100" type="number"
                      tooltip="Min Plot Area">Min</Input>
                    <Input id="max_lot_area" :model-value="form.maxLotArea"
                      @change="(value: string) => { form.maxLotArea = value }" :placeholder="500" type="number"
                      tooltip="Max Plot Area">Max</Input>
                    <span class="col-span-2 text-destructive text-xs"
                      v-if="form.minLotArea && form.maxLotArea && parseInt(form.minLotArea) > parseInt(form.maxLotArea)">
                      Min cannot be greater than Max
                    </span>
                  </div>
                </div>
              </div>
            </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          @click="resetForm"
        >
          Reset
        </button>
        <button
          type="button"
          class="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!!isFormInvalid"
          @click="applyFilters"
        >
          Search
        </button>
      </div>
    </template>
  </UiModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import Input from '~/components/Input.vue'
import { showToast } from '~/helpers/helpers'
import { UrlBuilder } from '@innova2/url-builder'
import { formatPrice } from '~/helpers/helpers'

// Get Supabase client
const nuxtApp = useNuxtApp()

const props = defineProps({
  availableFilters: {
    type: Object,
    required: true,
  },
  advancedFiltersSidebarOpen: Boolean,
})

const emit = defineEmits(['toggleAdvancedFiltersSidebar', 'applyFilters'])

// Debug: Log available filters whenever they change
watch(() => props.availableFilters, (newVal) => {
  console.log('=== AVAILABLE FILTERS DEBUG ===')
  console.log('Cities:', newVal.cities)
  console.log('Cities count:', newVal.cities?.length || 0)
  console.log('Barangays:', newVal.barangays)
  console.log('Barangays count:', newVal.barangays?.length || 0)
  console.log('Full availableFilters object:', newVal)
  console.log('================================')
}, { immediate: true, deep: true })

const form = ref({
  forId: '',
  typeId: '',
  conditionId: '',
  parking: '',
  location: '',
  locationType: '', // 'city' or 'barangay'
  locationId: '', // store the actual ID
  availabilityFrom: '',
  availabilityTo: '',
  minBedroom: '',
  maxBedroom: '',
  minBathroom: '',
  maxBathroom: '',
  minPrice: '',
  maxPrice: '',
  minPps: '',
  maxPps: '',
  minFloorArea: '',
  maxFloorArea: '',
  minLotArea: '',
  maxLotArea: '',
})

// Location autocomplete state
const locationSearch = ref('')
const showLocationSuggestions = ref(false)
const selectedLocation = ref<any>(null)
const locationSuggestions = ref<any[]>([])
const isSearchingLocations = ref(false)
let searchDebounceTimer: NodeJS.Timeout | null = null

// Define property types for each category
const propertyTypes = {
  residential: [
    { id: 'condo', name: 'Condo' },
    { id: 'house', name: 'House' },
    { id: 'lot', name: 'Lot' },
    { id: 'villa', name: 'Villa' }
  ],
  commercial: [
    { id: 'building', name: 'Building' },
    { id: 'office-space', name: 'Office Space' },
    { id: 'hotel', name: 'Hotel' },
    { id: 'resort', name: 'Resort' },
    { id: 'serviced-office', name: 'Serviced Office' },
    { id: 'warehouse', name: 'Warehouse' }
  ]
}

// Reactive division parameter tracking
const currentDivision = ref('residential')

// Function to update division from URL
function updateDivisionFromUrl() {
  const urlBuilder = UrlBuilder.createFromUrl(window.location.href)
  const division = urlBuilder.getQueryParams().get('division')

  if (division === 'residential' || division === 'commercial') {
    currentDivision.value = division
    console.log('Division updated to:', division)
  } else {
    currentDivision.value = 'residential'
    console.log('Division defaulted to: residential')
  }
}

// Watch for URL changes using a more reliable method
let urlCheckInterval: NodeJS.Timeout | null = null

function startUrlWatcher() {
  let lastUrl = window.location.href

  urlCheckInterval = setInterval(() => {
    const currentUrl = window.location.href
    if (currentUrl !== lastUrl) {
      console.log('URL changed from', lastUrl, 'to', currentUrl)
      lastUrl = currentUrl
      updateDivisionFromUrl()
    }
  }, 100) // Check every 100ms
}

function stopUrlWatcher() {
  if (urlCheckInterval) {
    clearInterval(urlCheckInterval)
    urlCheckInterval = null
  }
}

// Computed property to filter property types based on division parameter
const filteredPropertyTypes = computed(() => {
  console.log('Computing property types for division:', currentDivision.value)
  return propertyTypes[currentDivision.value as keyof typeof propertyTypes] || propertyTypes.residential
})

// Fetch location suggestions from search_suggestions table
async function fetchLocationSuggestions(searchTerm: string) {
  if (!searchTerm || searchTerm.length <= 2) {
    locationSuggestions.value = []
    return
  }

  isSearchingLocations.value = true
  console.log('=== FETCHING LOCATION SUGGESTIONS ===')
  console.log('Search term:', searchTerm)

  try {
    // Fetch from search_suggestions
    const { data: suggestionsData, error: suggestionsError } = await useSupabaseClient()
      .from('search_suggestions')
      .select('name, description, city_id, barangay_id, property_id')
      .ilike('name', `%${searchTerm}%`)
      .order('popularity', { ascending: false })
      .limit(10)

    // Reads from `listing_details` (canonical wide read source —
    // restored 2026-05-01). The view exposes unit_number directly.
    const { data: unitData, error: unitError } = await useSupabaseClient()
      .from('listing_details')
      .select('unit_number')
      .ilike('unit_number', `%${searchTerm}%`)
      .limit(5)

    const combinedResults = []

    if (suggestionsData && suggestionsData.length > 0) {
      combinedResults.push(...suggestionsData)
    }

    if (unitData && unitData.length > 0) {
      // Add unit numbers as suggestions
      unitData.forEach(unit => {
        combinedResults.push({
          name: unit.unit_number,
          description: `Unit ${unit.unit_number}`,
          city_id: null,
          barangay_id: null,
          property_id: null,
          unit_number: unit.unit_number
        })
      })
    }

    if (suggestionsError) {
      console.error('Error fetching location suggestions:', suggestionsError)
    }
    if (unitError) {
      console.error('Error fetching unit numbers:', unitError)
    }

    console.log('Fetched suggestions:', combinedResults.length)
    locationSuggestions.value = combinedResults
  } catch (err) {
    console.error('Exception fetching location suggestions:', err)
    locationSuggestions.value = []
  } finally {
    isSearchingLocations.value = false
    console.log('===================================')
  }
}

// Computed property for filtered locations (now uses API results)
const filteredLocations = computed(() => {
  return locationSuggestions.value
})

// Handle location input with debounced API search
function handleLocationInput() {
  showLocationSuggestions.value = true

  // Clear selection when typing
  if (locationSearch.value !== selectedLocation.value?.name) {
    selectedLocation.value = null
    form.value.location = ''
    form.value.locationType = ''
    form.value.locationId = ''
  }

  // Debounce the API call
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }

  searchDebounceTimer = setTimeout(() => {
    fetchLocationSuggestions(locationSearch.value)
  }, 300)
}

// Handle location blur
function handleLocationBlur() {
  // Delay hiding to allow click event on suggestions
  setTimeout(() => {
    showLocationSuggestions.value = false
  }, 200)
}

// Select a location from suggestions
function selectLocation(suggestion: any) {
  selectedLocation.value = {
    name: suggestion.name,
    description: suggestion.description,
    city_id: suggestion.city_id,
    barangay_id: suggestion.barangay_id,
    property_id: suggestion.property_id,
    unit_number: suggestion.unit_number
  }

  locationSearch.value = suggestion.name
  form.value.location = suggestion.name

  // Determine location type based on which IDs are present
  if (suggestion.unit_number) {
    form.value.locationType = 'unit_number'
    form.value.locationId = suggestion.unit_number
  } else if (suggestion.property_id) {
    form.value.locationType = 'property'
    form.value.locationId = suggestion.property_id
  } else if (suggestion.barangay_id) {
    form.value.locationType = 'barangay'
    form.value.locationId = suggestion.barangay_id
  } else if (suggestion.city_id) {
    form.value.locationType = 'city'
    form.value.locationId = suggestion.city_id
  }

  locationSuggestions.value = []
  showLocationSuggestions.value = false

  console.log('Selected location:', {
    name: suggestion.name,
    description: suggestion.description,
    city_id: suggestion.city_id,
    barangay_id: suggestion.barangay_id,
    property_id: suggestion.property_id,
    locationType: form.value.locationType,
    locationId: form.value.locationId,
  })
}

// Watch for popstate events (browser back/forward)
function handlePopState() {
  console.log('Popstate event detected')
  updateDivisionFromUrl()
}

function resetForm() {
  const urlBuilder = UrlBuilder.createFromUrl(window.location.href)

  const divisionCopy = urlBuilder.getQueryParams().get('division')!
  const viewCopy = urlBuilder.getQueryParams().get('view')!

  //remove all query params but leave only division and view
  urlBuilder.getQueryParams().clear()
  urlBuilder.getQueryParams().set('division', divisionCopy)
  urlBuilder.getQueryParams().set('view', viewCopy)

  window.history.pushState({}, '', urlBuilder.toString())

  form.value = {
    forId: '',
    typeId: '',
    conditionId: '',
    parking: '',
    location: '',
    locationType: '',
    locationId: '',
    availabilityFrom: '',
    availabilityTo: '',
    minBedroom: '',
    maxBedroom: '',
    minBathroom: '',
    maxBathroom: '',
    minPrice: '',
    maxPrice: '',
    minPps: '',
    maxPps: '',
    minFloorArea: '',
    maxFloorArea: '',
    minLotArea: '',
    maxLotArea: '',
  }

  // Clear location autocomplete state
  locationSearch.value = ''
  selectedLocation.value = null
  showLocationSuggestions.value = false
  locationSuggestions.value = []

  emit('applyFilters')

  showToast({
    title: 'Advanced filters successfully reset',
    icon: 'success',
  })
}

onMounted(() => {
  // Initialize division from URL
  updateDivisionFromUrl()

  // Start URL watcher
  startUrlWatcher()

  // Add popstate event listener for browser navigation
  window.addEventListener('popstate', handlePopState)

  const urlParams = UrlBuilder.createFromUrl(window.location.href)
  const urlParamsObject = urlParams.getQueryParams().getAll()

  // Populate form with URL parameters
  Object.keys(form.value).forEach(key => {
    if (urlParamsObject[key]) {
      (form.value as Record<string, string>)[key] = String(urlParamsObject[key])
    }
  })

  // Restore location autocomplete state from URL
  if (urlParamsObject.location) {
    locationSearch.value = String(urlParamsObject.location)
    form.value.location = String(urlParamsObject.location)

    if (urlParamsObject.locationType) {
      form.value.locationType = String(urlParamsObject.locationType)
    }
    if (urlParamsObject.locationId) {
      form.value.locationId = String(urlParamsObject.locationId)
    }
  }

  console.log('urlParamsObject: ', urlParamsObject)
  console.log('Initial URL division:', urlParams.getQueryParams().get('division'))
  resetForm()
})

onUnmounted(() => {
  // Clean up URL watcher
  stopUrlWatcher()

  // Remove popstate event listener
  window.removeEventListener('popstate', handlePopState)
})

const isFormInvalid = computed(() => {

  return (
    (form.value.availabilityFrom &&
      form.value.availabilityTo &&
      form.value.availabilityFrom > form.value.availabilityTo) ||
    (form.value.minBedroom &&
      form.value.maxBedroom &&
      parseInt(form.value.minBedroom) > parseInt(form.value.maxBedroom)) ||
    (form.value.minBathroom &&
      form.value.maxBathroom &&
      parseInt(form.value.minBathroom) > parseInt(form.value.maxBathroom)) ||
    (form.value.minPrice &&
      form.value.maxPrice &&
      parseInt(form.value.minPrice) > parseInt(form.value.maxPrice)) ||
    (form.value.minPps &&
      form.value.maxPps &&
      parseInt(form.value.minPps) > parseInt(form.value.maxPps)) ||
    (form.value.minFloorArea &&
      form.value.maxFloorArea &&
      parseInt(form.value.minFloorArea) > parseInt(form.value.maxFloorArea)) ||
    (form.value.minLotArea &&
      form.value.maxLotArea &&
      parseInt(form.value.minLotArea) > parseInt(form.value.maxLotArea))
  )
})

function applyFilters() {
  if (!isFormInvalid.value) {
    const urlBuilder = UrlBuilder.createFromUrl(window.location.href)

    // First, preserve division and view params
    const divisionCopy = urlBuilder.getQueryParams().get('division')
    const viewCopy = urlBuilder.getQueryParams().get('view')

    // Clear all existing params
    urlBuilder.getQueryParams().clear()

    // Restore division and view
    if (divisionCopy) urlBuilder.getQueryParams().set('division', divisionCopy)
    if (viewCopy) urlBuilder.getQueryParams().set('view', viewCopy)

    // Process form data to only include non-empty values
    const formData = Object.entries(form.value).filter(([key, value]) => {
      return value !== undefined && value !== null && value !== '';
    });

    console.log('=== COMPLETE FILTER DEBUG ===');
    console.log('Raw form data:', form.value);
    console.log('Filtered form data:', formData);

    // Enhanced parking filter debugging
    console.log('=== PARKING FILTER DEBUG ===');
    console.log('parking value:', form.value.parking, 'type:', typeof form.value.parking);

    // Enhanced bedroom and bathroom filter debugging
    console.log('=== BEDROOM FILTER DEBUG ===');
    console.log('minBedroom value:', form.value.minBedroom, 'type:', typeof form.value.minBedroom);
    console.log('maxBedroom value:', form.value.maxBedroom, 'type:', typeof form.value.maxBedroom);

    console.log('=== BATHROOM FILTER DEBUG ===');
    console.log('minBathroom value:', form.value.minBathroom, 'type:', typeof form.value.minBathroom);
    console.log('maxBathroom value:', form.value.maxBathroom, 'type:', typeof form.value.maxBathroom);

    console.log('=== LOCATION FILTER DEBUG ===');
    console.log('location value:', form.value.location);
    console.log('locationType value:', form.value.locationType);
    console.log('locationId value:', form.value.locationId);

    // Check if values are being included in formData
    const parkingData = formData.filter(([key]) => key.includes('parking'));
    const bathroomData = formData.filter(([key]) => key.includes('Bathroom'));
    const bedroomData = formData.filter(([key]) => key.includes('Bedroom'));
    console.log('Parking data being sent:', parkingData);
    console.log('Bathroom data being sent:', bathroomData);
    console.log('Bedroom data being sent:', bedroomData);

    for (const [key, value] of formData) {
      if (value) {
        // Special-case parking: force clean integer and set both parking and parking_spaces params
        if (key === 'parking') {
          const n = parseInt(String(value).replace(/[^0-9]/g, ''), 10)
          if (!Number.isNaN(n)) {
            console.log('Normalized parking to integer:', n)
            // primary param expected by backend
            urlBuilder.getQueryParams().set('parking', String(n))
            // also send parking_spaces to directly match DB column if needed
            urlBuilder.getQueryParams().set('parking_spaces', String(n))
            console.log('Setting parking and parking_spaces to:', n)
          }
          continue
        }

        // Ensure numeric values are properly converted to strings for URL
        let processedValue = value
        if (['minBedroom', 'maxBedroom', 'minBathroom', 'maxBathroom', 'minPrice', 'maxPrice', 'minPps', 'maxPps', 'minFloorArea', 'maxFloorArea', 'minLotArea', 'maxLotArea'].includes(key)) {
          processedValue = String(value)
          console.log(`Converting ${key} from ${value} (${typeof value}) to ${processedValue} (${typeof processedValue})`)
        }

        urlBuilder.getQueryParams().set(key, processedValue)

        if (key === 'minBathroom' || key === 'maxBathroom' || key === 'minBedroom' || key === 'maxBedroom') {
          console.log(`Setting ${key} to:`, processedValue, 'type:', typeof processedValue)
        }
      }
    }

    // Log the final URL for debugging
    console.log('Final URL: ', urlBuilder.toString())

    window.history.pushState({}, '', urlBuilder.toString())
    emit('applyFilters')

    // Close the modal after applying filters
    emit('toggleAdvancedFiltersSidebar')
  }
}
</script>
