<template>
  <div class="flex mb-6 xs:flex-col flex-col md:flex-col lg:flex-row">
    <!-- Search -->
    <div
      class="relative flex items-center justify-between flex-1 px-3 py-2 mb-2 bg-card border rounded-lg hi-search sm:flex-row focus-within:border-blue border-2 border-border"
    >
      <div class="flex items-center w-full">
        <font-awesome-icon icon="magnifying-glass" class="mr-2 text-muted-foreground" />
        <div class="relative w-full">
          <input
            id="searchInput"
            type="text"
            v-on:input="getSearchResults"
            @keydown.enter="handleEnterKey"
            placeholder="Search"
            v-model="currentSearchString"
            class="flex-1 w-full font-bold border-0 focus:outline-none focus:shadow-none focus:ring-0 placeholder-gray-3"
          />
        </div>
        <!-- Search results dropdown removed - all searches now filter the main table -->
      </div>

      <div class="flex items-center">
        <div
          ref="currentSearchTermBox"
          class="border-gray-402 border-l-2 h-full"
        >
          <div
            @click="
              () => {
                searchTermOptionsBox.style.display == 'flex'
                  ? (searchTermOptionsBox.style.display = 'none')
                  : (searchTermOptionsBox.style.display = 'flex')
              }
            "
            v-on-clickaway="
              () => {
                searchTermOptionsBox.style.display = 'none'
              }
            "
            class="cursor-pointer hover:bg-gray-401 bg-muted min-w-10 w-[30vw] py-4 sm:w-[10vw] mx-2 px-3 rounded-lg h-[2vw] flex items-center justify-between"
          >
            <span
              class="text-foreground w-full text-xs lg:text-sm font-bold"
            >
              {{ selectedColumn.label }}
            </span>
            <font-awesome-icon icon="caret-down" class="text-gray-350 mb-1" />
          </div>
        </div>
        <button
          @click="
            () => {
              currentSearchString = ''
              emit('FilterTableData', {
                searchColumn: selectedColumn.associated_property,
                searchValue: '',
              })
            }
          "
          type="button"
          class="ml-2 text-muted-foreground hover:text-foreground cursor-pointer"
          title="Clear search"
        >
          <font-awesome-icon icon="arrow-rotate-right" class="text-lg" />
        </button>
      </div>
      <transition name="fade" mode="out-in">
        <div
          ref="searchTermOptionsBox"
          id="searchTermOptionsBox"
          class="hidden overflow-auto flex flex-col absolute !top-10 w-26 lg:w-[10.5vw] min-h-[2vw] rounded-lg border-border border-2 bg-card z-50"
        >
          <div
            v-for="(column, index) in availableColumns"
            :key="column.label"
            @touchend.prevent="() => {
                const searchColumns = [...availableColumns]
                const temp = searchColumns[0]
                searchColumns[0] = searchColumns[index]
                searchColumns[index] = temp

                selectedColumn = {
                  label: column.label,
                  associated_property: column.associated_property,
                }
                emit('searchColumns', selectedColumn.associated_property)
                currentSearchTerm = selectedColumn.associated_property

                handleAdvancedSearch()

                searchTermOptionsBox.style.display = 'none'
                console.log('searchColumns: ', searchColumns)

                showSearchResults = false
                currentSearchString = ''
                searchResults = []
              }"
            @click="
              () => {
                const searchColumns = [...availableColumns]
                const temp = searchColumns[0]
                searchColumns[0] = searchColumns[index]
                searchColumns[index] = temp

                selectedColumn = {
                  label: column.label,
                  associated_property: column.associated_property,
                }
                emit('searchColumns', selectedColumn.associated_property)
                currentSearchTerm = selectedColumn.associated_property

                handleAdvancedSearch()

                searchTermOptionsBox.style.display = 'none'
                console.log('searchColumns: ', searchColumns)

                showSearchResults = false
                currentSearchString = ''
                searchResults = []
              }
            "
            class="px-3 py-2 hover:bg-muted cursor-pointer"
          >
            <span>{{ column.label }}</span>
          </div>
        </div>
      </transition>
    </div>
    <!-- Filters and Buttons -->
    <div
      class="flex flex-col justify-between sm:flex-row"
    >
      <div
        class="hidden w-px h-8 mt-2 ml-6 mr-3 border border-l-0 border-gray-402 sm:hidden md:hidden lg:inline"
      ></div>
      <div
        class="flex flex-col sm:flex-row md:flex-row lg:flex-row lg:px-3 py-1.5"
      >
        <TableFilter
          label="Contact Designation"
          v-model="designationFilter"
          :options="designationOptions"
          withAction
          @action="onDesignationSelected"
        />
      </div>
      <!-- <div
        class="flex flex-col sm:flex-row md:flex-row lg:flex-row lg:px-3 py-1.5"
      >
        <div>
          <VSelect
            id="designation"
            class="w-[12vw]"
            v-model="designationFilter"
            :clearable="true"
            placeholder="Contact Designation"
            required
            :options="designationOptions"
            label="label"
            :reduce="(item) => item.value"
            @option:selected="onDesignationSelected"
          >
          </VSelect>
        </div>
      </div> -->
      <div
        class="hidden w-px h-8 mt-2 mr-3 border border-l-0 border-gray-402 sm:hidden md:hidden lg:inline"
      ></div>
      <div class="hidden sm:block">
        <button
          type="button"
          @click="$emit('addListing')"
          class="rounded-lg w-39 h-9 sm:mr-5 lg:ml-3 bg-green hover:bg-green-dark"
          style="margin-top: 5px"
        >
          <span class="inline-block text-white font-bold mt-0.5"
            >New Listing</span
          >
          <font-awesome-icon
            icon="arrow-up-from-bracket"
            class="ml-2 text-white"
          />
        </button>
        <button
          type="button"
          @click="exportListings"
          class="rounded-lg w-39 h-9 lg:ml-3 bg-green hover:bg-green-dark"
          style="margin-top: 5px"
        >
          <span class="inline-block text-white font-bold mt-0.5">Export</span>
        </button>
      </div>
      <div class="flex sm:hidden gap-2">
        <button
          type="button"
          @click="$emit('addListing')"
          class="rounded-lg w-39 h-9 lg:ml-3 bg-green hover:bg-green-dark"
          style="margin-top: 5px"
        >
          <span class="inline-block text-white font-bold mt-0.5"
            >New Listing</span
          >
          <font-awesome-icon
            icon="arrow-up-from-bracket"
            class="ml-2 text-white"
          />
        </button>
        <button
          type="button"
          @click="exportListings"
          class="rounded-lg w-39 h-9 lg:ml-3 bg-green hover:bg-green-dark"
          style="margin-top: 5px"
        >
          <span class="inline-block text-white font-bold mt-0.5">Export</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { library } from '@fortawesome/fontawesome-svg-core'
import listingService from '@/services/listing.services'
import { showToast } from '~/helpers/helpers'
import TableFilter from '~/components/tables/Filter.vue'
import { faRecycle, faMagnifyingGlass, faArrowRotateRight } from '@fortawesome/free-solid-svg-icons'
import { toRaw } from 'vue'
import { useListingColumnsAtom } from '~/store'
import { generateReport } from '~/services/listings/generateReport'
import { UrlBuilder } from '@innova2/url-builder'
library.add(faRecycle, faMagnifyingGlass, faArrowRotateRight)

const { listingColumnsData } = useListingColumnsAtom()

const currentSearchTerm = ref('')
const availableColumns = ref([
  { label: 'Property ID', associated_property: 'listing_id' },
  { label: 'Property Name', associated_property: 'title' },
  {
    label: 'Advanced Search ▶',
    associated_property: 'advanced_search',
  },
  { label: 'Bldg/Unit Number', associated_property: 'unit_number' },
  { label: 'Property Location', associated_property: 'city_name' },
  { label: 'Contact Person', associated_property: 'contact_name' },
])
const props = defineProps({
  division: Number,
  searchColumns: Array,
  designations: Array,
  isOnlineOptions: Array,
  inputSearchString: String,
  FilterTableData: Function,
  listingColumnsData: Array,
  toggleListingDetailsSidebar: Function,
  addListing: Function,
  getListings: Function,
  toggleAdvancedFiltersSidebar: Function,
})

const emit = defineEmits([
  'addSortCity',
  'searchColumns',
  'inputSearchString',
  'contactDesignationInput',
  'displayStatusInput',
  'resetSearch',
  'initiateSearch',
  'searchColumnsInput',
  'addListing',
  'exportSearchQuery',
  'FilterTableData',
  'toggleListingDetailsSidebar',
  'getListings',
  'toggleAdvancedFiltersSidebar',
])

const designationFilter = ref(null)
const designationOptions = ref([''])
const typeOptions = ref([])

const selectedColumn = ref({
  label: 'Property ID',
  associated_property: 'listing_id',
})

const alterURLParams = async (
  associated_property: string,
  resultSelected: any
) => {
  const user = useSupabaseUser()
  console.log('alterURLParams: ', selectedColumn)

  console.log('associated_property: ', associated_property)
  console.log('resultSelected: ', resultSelected)
  const url = UrlBuilder.createFromUrl(window.location.origin)

  if (resultSelected.created_by !== user.value?.id) {
    url.getQueryParams().set('view', 'broker')
  } else {
    url.getQueryParams().set('view', 'personal')
    console.log('Adaugat view=personal')
  }

  if (resultSelected.property_category)
    url.getQueryParams().set('division', resultSelected.property_category)

  if (!resultSelected.property_category)
    url.getQueryParams().set('division', 'residential')

  url
    .getQueryParams()
    .set(
      'searchText',
      `[${associated_property}, ${resultSelected[associated_property]}]`
    )
  // // add url query param to the url: associated_property=resultSelected
  // url.searchParams.set(
  //   'searchText',
  //   `[${associated_property}, ${resultSelected[associated_property]}]`
  // )
  window.history.pushState({}, '', url)

  emit('getListings')
}

async function exportListings() {
  console.log('export listings:', props.listingColumnsData)
  // const response = await fetch('/api/listings/generate-report', {
  //   method: 'POST',
  //   body: JSON.stringify(props.listingColumnsData),
  // })

  const response = await generateReport(props.listingColumnsData)

  if (!response) {
    console.error('Failed to generate report:', response)
    showToast({
      title: 'Failed to generate report',
      icon: 'error',
    })
    return
  }

  const csv = response
  console.log('CSV: ', csv)

  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'listings.csv'
  a.click()
}

const searchResultsBox = ref<HTMLDivElement | null>(null)
const currentSearchString = ref('')
const searchResults = ref<any[]>([])
const showSearchResults = ref(false)
const isLoading = ref(false)
let searchTimeout: NodeJS.Timeout | null = null

const getSearchResults = async () => {
  // Clear previous timeout
  if (searchTimeout) {
    clearTimeout(searchTimeout)
  }

  // For all search types, trigger automatic filtering with delay
  searchTimeout = setTimeout(() => {
    emit('FilterTableData', {
      searchColumn: selectedColumn.value.associated_property,
      searchValue: currentSearchString.value,
    })
    showSearchResults.value = false
  }, 500) // 500ms delay after user stops typing
}

const handleEnterKey = () => {
  // For any search type, trigger immediate search on Enter
  emit('FilterTableData', {
    searchColumn: selectedColumn.value.associated_property,
    searchValue: currentSearchString.value,
  })
  showSearchResults.value = false
}

const performSearch = async () => {
  console.log(
    '🚀 ~ file: Search.vue:183 ~ getSearchResults ~ currentSearchString.value:',
    currentSearchString.value
  )
  const url = UrlBuilder.createFromUrl(window.location.href)
  const searchTextParam = url.getQueryParams().get('searchText')

  if (!currentSearchString.value && searchTextParam) {
    searchResults.value = []
    showSearchResults.value = false

    //check if searchText exists in url and remove it
    const url = new URL(window.location.href)
    url.searchParams.delete('searchText')
    window.history.pushState({}, '', url)

    setTimeout(() => {
      emit('getListings')
    }, 1000)
    return
  }

  // Don't show suggestions for any search type - all searches filter the main table
  showSearchResults.value = false
  searchResults.value = []

  const searchTerm = currentSearchString.value.toLowerCase()

  isLoading.value = true
  searchResults.value = []

  const division = url.getQueryParams().get('division')
  const view = url.getQueryParams().get('view')

  console.log(
    'selectedColumn.value.associated_property: ',
    selectedColumn.value.associated_property
  )

  console.log('searchTerm: ', searchTerm)
  const nuxtApp = useNuxtApp()

  try {
    if (selectedColumn.value.associated_property === 'listing_id') {
      // For Property ID: Show listings with names and addresses.
      // The view's PK was renamed listing_id → id; alias it back for the
      // response so consumers reading row.listing_id keep working.
      const { data: availableSuggestions } = await useSupabaseClient()
        .from('listing_details')
        .select('*')
        .eq('listing_id', parseInt(searchTerm))

      console.log('availableSuggestions: ', availableSuggestions)
      if (availableSuggestions && availableSuggestions.length > 0) {
        searchResults.value = availableSuggestions
      }
    } else if (selectedColumn.value.associated_property === 'title') {
      // For Property Name: Show listings with names and addresses
      const { data: availableSuggestions } = await useSupabaseClient()
        .from('listing_details')
        .select('*')
        .ilike('title', `%${searchTerm}%`)
        .limit(10)

      console.log('availableSuggestions: ', availableSuggestions)
      if (availableSuggestions && availableSuggestions.length > 0) {
        searchResults.value = availableSuggestions
      }
    } else if (selectedColumn.value.associated_property === 'unit_number') {
      // For Bldg/Unit Number: Direct search - filter the main table instead of showing suggestions
      // Don't show suggestions, just set the search term and let the parent component handle filtering
      showSearchResults.value = false
      searchResults.value = []

      // Emit the search to parent component to filter the main table
      emit('FilterTableData', {
        searchColumn: 'unit_number',
        searchValue: searchTerm,
      })

      return
    } else if (selectedColumn.value.associated_property === 'city_name') {
      // Autocomplete against the canonical cities table — no longer reads
      // listings.city_name (slated for removal in migration F). The result
      // shape stays { city_name, title, ... } so downstream filter handlers
      // don't need to change.
      const { data: availableSuggestions } = await useSupabaseClient()
        .from('cities')
        .select('name')
        .ilike('name', `%${searchTerm}%`)
        .order('name')
        .limit(20)

      if (availableSuggestions && availableSuggestions.length > 0) {
        searchResults.value = availableSuggestions.map((row) => ({
          city_name: row.name,
          title: row.name,
          street_address: '',
        }))
      }
    } else if (selectedColumn.value.associated_property === 'contact_name') {
      // Autocomplete against contacts directly — no longer reads
      // listings.contact_name (slated for removal in migration E).
      const { data: availableSuggestions } = await useSupabaseClient()
        .from('contacts')
        .select('id, full_name')
        .ilike('full_name', `%${searchTerm}%`)
        .order('full_name')
        .limit(20)

      if (availableSuggestions && availableSuggestions.length > 0) {
        searchResults.value = availableSuggestions.map((row) => ({
          contact_id: row.id,
          contact_name: row.full_name,
          title: row.full_name,
          street_address: '',
        }))
      }
    } else {
      // Default fallback for other search types
      const { data: availableSuggestions } = await useSupabaseClient()
        .from('listing_details')
        .select('*')
        .textSearch(selectedColumn.value.associated_property, searchTerm)
      console.log('availableSuggestions: ', availableSuggestions)
      if (availableSuggestions && availableSuggestions.length > 0) {
        searchResults.value = availableSuggestions
      }
    }
  } catch (error) {
    console.error('Error searching:', error)
    searchResults.value = []
  } finally {
    isLoading.value = false
  }
}

const currentSearchTermBox = ref<HTMLDivElement | null>(null)
const searchTermOptionsBox = ref<HTMLDivElement | null>(null)
const contactDesignation = ref(null)
const displayStatus = ref(null)

const listingsUrlParams = reactive({
  division: props.division,
  building: null,
  area: null,
  city: null,
  designation: null,
  isOnline: null,
  page: null,
  search: null,
  searchColumn: 'id',
  searchQuery: null,
  sortedAreaName: null,
  sortedBuildingName: null,
  sortedCityNames: null,
  sortedContactDesignationName: null,
})

onMounted(async () => {
  document.querySelector('body')?.classList.add('overflow-x-hidden')

  showSearchResults.value = false
  searchTermOptionsBox.value!.classList.add('hidden')

  searchTermOptionsBox.value!.style.top = `3vw`
  searchTermOptionsBox.value!.style.right = `0`

  //get query params from url
  const url = new URL(window.location.href)
  const urlParams = Object.fromEntries(url.searchParams)

  let searchTerm = ''
  let searchString = ''
  if (urlParams.searchText) {
    const searchTextMatch = urlParams.searchText.match(/\[(.*?),(.*?)\]/)
    if (searchTextMatch) {
      const [_, field, value] = searchTextMatch
      searchTerm = field
      searchString = value
    }

    currentSearchString.value = searchString
    selectedColumn.value.associated_property = searchTerm

    selectedColumn.value.label = availableColumns.value.find(
      (column) => column.associated_property === searchTerm
    )?.label
  }

  document.addEventListener('click', (e) => {
    if (e.target.id !== 'searchResultsBox' && e.target.id !== 'searchInput') {
      showSearchResults.value = false
    } else if (e.target.id == 'searchInput' && e.target.value !== '') {
      showSearchResults.value = true
    }
  })

  await fetchDesignations()
})

onUnmounted(() => {
  // Cleanup timeout to prevent memory leaks
  if (searchTimeout) {
    clearTimeout(searchTimeout)
  }
})

const fetchDesignations = async () => {
  const nuxtApp = useNuxtApp()

  const { data, error } = await useSupabaseClient().from('designations').select('*')

  if (error) {
    console.error('Error fetching designations:', error)
  }

  designationOptions.value = data.map((designation) => ({
    label: designation.display_name || designation.name,
    value: designation.id,
  }))

  designationOptions.value.unshift({
    label: 'All',
    value: 'all',
  })
}

const handleAdvancedSearch = () => {
  if (selectedColumn.value.associated_property === 'advanced_search') {
    emit('toggleAdvancedFiltersSidebar')
    selectedColumn.value.associated_property = 'listing_id'
    currentSearchTerm.value = 'listing_id'
  }
}

const onDesignationSelected = (value: any) => {
  console.log('onDesignationSelected: ', value)
  const url = UrlBuilder.createFromUrl(window.location.href)

  if (value === 'all') {
    url.getQueryParams().delete('designation')
  } else {
    url.getQueryParams().set('designation', value)
  }
  window.history.pushState({}, '', url)
  emit('getListings')
}

watch(designationFilter, (newVal) => {
  console.log('designationFilter: ', newVal)
  if (newVal == null) {
    console.log('designationFilter: ', newVal)
    const url = UrlBuilder.createFromUrl(window.location.href)
    url.getQueryParams().delete('designation')
    window.history.pushState({}, '', url)
    emit('getListings')
  }
})
</script>
