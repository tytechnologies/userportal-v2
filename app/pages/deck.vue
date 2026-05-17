<template>
  <div class="w-full">
    <div class="flex w-full">
      <div class="flex-col flex-1 w-0 mb-8">
        <!-- Division Tabs -->
        <nav
          class="flex items-center justify-between mb-4 border-b h-14 border-border"
        >
          <div class="flex">
            <button
              v-for="value in table.divisions"
              :key="value.id"
              type="button"
              @click="changeDivisionTab(value.id)"
              class="mr-8 text-xs font-bold sm:text-sm md:text-sm lg:text-sm h-14"
              :class="activeDivision(value.id)"
            >
              {{ value.name }}
            </button>

            <button
              type="button"
              class="hidden text-xs font-bold sm:block md:block sm:text-sm md:text-sm lg:text-sm"
              @click="$refs.generateReportModal.toggleModal()"
            >
              {{ divisionTitle }} ({{
                selectedListingForGenerateReport.length
              }})
            </button>
          </div>
          <div class="hidden sm:block md:block lg:block">
            <button
              type="button"
              @click="$refs.advanceFiltersModal.toggleModal()"
              class="w-8 h-8 pt-1 my-auto ml-4 text-center rounded-full bg-muted hover:bg-muted"
            >
              <font-awesome-icon icon="sliders" class="text-sm" />
            </button>
          </div>
        </nav>

        <SearchSection
          :division="listingsUrlParams.division"
          :designations="table.designations"
          :isOnlineOptions="table.isOnlineOptions"
          :searchColumns="table.searchColumns"
          @addSortCity="addSortCity"
          @addListing="addListing"
          @contactDesignationInput="contactDesignationInput"
          @displayStatusInput="displayStatusInput"
          @initiateSearch="initiateSearch"
          @resetSearch="resetSearch"
          @searchColumnsInput="searchColumnsInput"
        />

        <!-- toogle action sort/filters -->
        <div class="mb-2">
          <button type="button" class="mr-4 text-sm text-left text-primary">
            <input
              id="el-show-psqm"
              class="cursor-pointer form-check-input"
              type="checkbox"
              v-model="showPSqm"
            />
            <label
              class="my-auto text-center whitespace-no-wrap text-foreground"
              for="el-show-psqm"
            >
              Show P/Sqm
            </label>
          </button>
          <span
            v-show="hasSortContact"
            @click="resetSort(`contact`)"
            class="mr-2 whitespace-no-wrap cursor-pointer text-primary"
          >
            {{ sortedContactName }}&nbsp;<font-awesome-icon icon="xmark" />
          </span>
          <span
            v-show="hasSortContactDesignation"
            @click="resetSort(`contact_designation`)"
            class="mr-2 whitespace-no-wrap cursor-pointer text-primary"
          >
            {{ sortedContactDesignationName }}&nbsp;<font-awesome-icon
              icon="xmark"
            />
          </span>
          <span v-show="hasSortCity">
            <span
              v-for="(city, index) in sortedCityNames"
              :key="index"
              @click="resetSortCity(city)"
              class="whitespace-no-wrap cursor-pointer text-primary m2-2"
            >
              {{ city }}&nbsp;<font-awesome-icon icon="xmark" />
            </span>
          </span>
          <span
            v-show="hasSortArea"
            @click="resetSort(`area`)"
            class="whitespace-no-wrap cursor-pointer text-primary m2-2"
          >
            {{ sortedAreaName }}&nbsp;<font-awesome-icon icon="xmark" />
          </span>
          <span
            v-show="hasSortBuilding"
            @click="resetSort(`building`)"
            class="whitespace-no-wrap cursor-pointer text-primary m2-2"
          >
            {{ sortedBuildingName }}&nbsp;<font-awesome-icon icon="xmark" />
          </span>
        </div>

        <!-- Table -->
        <ListingsTable :table="table" @sorting="sorting">
          <template v-for="(row, index) in table.data">
            <tr
              :key="index"
              v-if="row.deleted_at == null"
              class="transition duration-300 ease-in-out bg-card"
            >
              <!-- Listing Name -->
              <td
                class="p-2 border-solid rounded-l-2xl border-border border-b-6 border-t-6"
              >
                <div
                  class="flex flex-col gap-3 p-2 whitespace-no-wrap rounded text-foreground bg-muted/30"
                >
                  <div class="flex flex-row">
                    <button
                      type="button"
                      class="mr-2 text-sm text-left text-primary"
                    >
                      <input
                        :class="`checkbox-${row.id}`"
                        class="cursor-pointer form-check-input"
                        type="checkbox"
                        v-model="checkboxData"
                        :value="row.id"
                        @click="(event) => addCheckBox(event, row)"
                      />
                    </button>

                    <RowInfoCard
                      :index="index"
                      :row="row"
                      :showOnlineStatus="true"
                      @changeListingOnlineStatus="changeListingOnlineStatus"
                    />
                  </div>

                  <Actions
                    :row="row"
                    className="mt-2 sm:hidden md:hidden lg:hidden flex-1"
                    @showUpdateListing="showUpdateListing"
                    @showRemarksModal="showRemarksModal"
                    @showPropertyLogs="showPropertyLogs"
                    @resetListings="resetListings"
                    @onDeckToggled="onDeckToggled"
                  />
                </div>
              </td>
              <!-- Price -->
              <td
                class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell"
              >
                <div
                  class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                >
                  <p
                    class="whitespace-no-wrap cursor-pointer text-foreground"
                    @click="showQuickUpdateModal(row, index)"
                  >
                    <span v-if="row.is_for_rent" class="block">
                      <strong>Rent:</strong>
                      {{ row.rent_price | currencySuffix }}/month
                    </span>
                    <span v-if="row.is_for_sale" class="block">
                      <strong>Sale:</strong>
                      {{ row.sale_price | currencySuffix }}
                    </span>
                  </p>
                </div>
              </td>
              <td
                v-show="showPSqm"
                class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell"
              >
                <div
                  class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                >
                  <p
                    v-show="showPSqm"
                    class="whitespace-no-wrap cursor-pointer text-foreground"
                    @click="showQuickUpdateModal(row, index)"
                  >
                    <span v-if="row.rent_pps > 0" class="block">
                      <strong>Rent:</strong> {{ row.rent_pps | currencySuffix }}
                    </span>
                    <span v-if="row.sale_pps > 0" class="block">
                      <strong>Sale:</strong> {{ row.sale_pps | currencySuffix }}
                    </span>
                  </p>
                </div>
              </td>
              <!-- City -->
              <td
                class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:hidden md:hidden lg:table-cell"
              >
                <div
                  class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                >
                  <p
                    class="whitespace-no-wrap cursor-pointer text-primary"
                    @click="sortCity(row)"
                  >
                    <span class="inline px-2 py-1 font-bold rounded bg-primary/10">
                      {{ row.city?.name ?? row.city_name }}
                    </span>
                  </p>
                </div>
              </td>
              <!-- Availabity -->
              <td
                class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:hidden md:table-cell lg:table-cell"
              >
                <div
                  class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                >
                  <p
                    class="whitespace-no-wrap cursor-pointer text-primary"
                    @click="showQuickUpdateModal(row, index)"
                  >
                    <span class="inline px-2 py-1 font-bold rounded bg-primary/10">
                      {{ row.availability | dateToLocaleDateString }}
                    </span>
                  </p>
                </div>
              </td>
              <!-- Contact -->
              <td
                class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:hidden md:hidden lg:table-cell"
              >
                <div
                  class="flex items-center h-full pr-2 whitespace-no-wrap cursor-pointer border-r-1"
                >
                  <div class="flex flex-col">
                    <p>
                      <span class="font-bold text-foreground">Name: </span>
                      <span :title="row.user_name" @click="sortContact(row)"
                        >{{ row.user_name | contactName }}
                      </span>
                    </p>
                    <p>
                      <span class="font-bold text-foreground">Designation:</span>
                      <span
                        @click="sortContactDesignation(row)"
                        :title="row.user_designation"
                        >{{ row.user_designation }}</span
                      >
                    </p>
                    <p
                      v-if="
                        $auth.user.id == row.uploader_id ||
                        internalDesignation.includes($auth.user.designation)
                      "
                    >
                      <span class="font-bold text-foreground">Email:</span>
                      <span :title="row.user_email">{{ row.user_email }}</span>
                    </p>
                    <p
                      v-if="
                        $auth.user.id == row.uploader_id ||
                        internalDesignation.includes($auth.user.designation)
                      "
                    >
                      <span class="font-bold text-foreground">Phone:</span>
                      <span :title="row.user_contact_number">{{
                        row.user_contact_number
                      }}</span>
                    </p>
                  </div>
                </div>
              </td>
              <!-- Actions -->
              <td
                class="hidden py-2 pl-2 pr-4 border-solid rounded-r-2xl border-border border-b-6 border-t-6 sm:table-cell md:table-cell lg:table-cell"
              >
                <Actions
                  :row="row"
                  :index="index"
                  @showUpdateListing="showUpdateListing"
                  @showRemarksModal="showRemarksModal"
                  @showPropertyLogs="showPropertyLogs"
                  @resetListings="resetListings"
                  @showCloneListing="showCloneListing"
                  @onDeckToggled="onDeckToggled"
                />
              </td>
            </tr>
          </template>
        </ListingsTable>
      </div>
    </div>

    <Modal :title="'Photo Gallery'" ref="galleryModal">
      <Gallery :listingId="selectedListingId" />
    </Modal>

    <Modal :title="modalTitle" ref="listingModal">
      <!-- <Form
        ref="listingModalForm"
        :updateListingId="updateListingId"
        :divisions="table.divisions"
        :listingActiveDivision="selectedDivision"
        :categories="table.categories"
        :statuses="table.statuses"
        :constants="optionSelections"
        @submitCallback="afterAddListing"
        :types="table.types"
      /> -->
    </Modal>

    <Modal :title="`Clone Listing`" ref="listingCloneModal">
      <CloneForm
        ref="listingModalCloneForm"
        :listing="cloneListing"
        @submitCallback="afterCloneListing"
      />
    </Modal>

    <Modal :title="`Property Remarks`" ref="listingRemarksModal">
      <RemarksForm
        :listing="selectedListing"
        @submitCallback="closeRemarksModal"
      />
    </Modal>

    <Modal :title="`Quick Update`" ref="listingQuickUpdateModal">
      <QuickUpdateForm
        :listing="selectedListing"
        :constants="optionSelections"
        :statuses="table.statuses"
        @submitCallback="closeQuickUpdateModal"
      />
    </Modal>

    <Modal :title="'Properties Preview'" ref="generateReportModal">
      <SelectedPropertyPreview
        :division="listingsUrlParams.division"
        :selectedListings="selectedListingForGenerateReport"
        :searchColumns="table.searchColumns"
        @removeListing="removeListingFromGenerateReport"
        @addListing="addListingFromGenerateReport"
        @close="$refs.generateReportModal.toggleModal()"
      />
    </Modal>

    <Modal :title="'Table View Options'" ref="settingsModal">
      <Settings
        :columns="table.columns || []"
        @change="columnChecked"
        @changeAll="showAllColumns"
      />
    </Modal>
    <Modal :title="'Advance Filters'" ref="advanceFiltersModal">
      <AdvanceFilters
        :categories="table.categories"
        :types="table.types"
        :listingActiveDivision="selectedDivision"
        :conditions="table.conditions"
        @searchCallback="searchCallback"
      />
    </Modal>

    <Modal :title="`History Log`" ref="logFormModal">
      <LogForm
        :listingId="selectedListingId"
        @submitCallback="closeLogFormModal"
      />
    </Modal>

    <Modal :title="modalTitle" ref="logListModal">
      <LogList :listingId="selectedListingId" />
    </Modal>
  </div>
</template>

<script>
import listingService from '@/services/listing.services'
import authService from '@/services/auth.services'
import debounce from 'lodash/debounce'
import { apiRoutes } from '~/contants'
import {
  dismissLoading,
  showLoading,
  showSwal,
  currencySuffix,
  showToast,
} from '@/helpers/helpers'
import { formatMoney } from '~/helpers/formatMoney'

// Components
import RowInfoCard from '@/components/pages/listings/ListingRowInfoCard'
import Actions from '@/components/pages/listings/ListingActions'
import AdvanceFilters from '@/components/pages/listings/AdvanceFilters'
import CloneForm from '@/components/pages/listings/CloneForm'
// import Form from '@/components/pages/listings/Form'
import Gallery from '@/components/pages/listings/Gallery'
import Input from '@/components/Input.vue'
import LogForm from '@/components/pages/listings/LogForm'
import LogList from '@/components/pages/listings/LogList'
import Modal from '@/components/Modal'
import QuickUpdateForm from '@/components/pages/listings/QuickUpdateForm'
import RemarksForm from '@/components/pages/listings/RemarksForm'
import SearchSection from '@/components/pages/listings/Search'
import SelectedPropertyPreview from '@/components/pages/listings/SelectedPropertyPreview.vue'
import Settings from '@/components/pages/listings/Settings'
import ListingsTable from '@/components/ListingsTable.vue'

import { library } from '@fortawesome/fontawesome-svg-core'

//import specific icons
import {
  faPesoSign,
  faCheck,
  faImage,
  faCar,
  faBed,
  faPaw,
  faXmark,
  faGear,
  faSliders,
} from '@fortawesome/free-solid-svg-icons'

library.add(
  faPesoSign,
  faCheck,
  faImage,
  faCar,
  faBed,
  faPaw,
  faXmark,
  faGear,
  faSliders
)

export default {
  head() {
    return {
      title: 'Listings | Housinginteractive.com.ph',
    }
  },
  middleware: ['auth'],
  mixins: [authService, listingService],
  components: {
    RowInfoCard,
    Actions,
    AdvanceFilters,
    CloneForm,
    // Form,
    Gallery,
    Input,
    LogForm,
    LogList,
    Modal,
    QuickUpdateForm,
    RemarksForm,
    SearchSection,
    SelectedPropertyPreview,
    Settings,
    ListingsTable,
  },
  filters: {
    currencySuffix: function (value) {
      return currencySuffix(value)
    },
    dateToLocaleDateString: function (value) {
      return new Date(value).toLocaleDateString()
    },
    contactName: function (value) {
      const first = value.split(' ')[0]
      return first || '--'
    },
  },
  data() {
    return {
      updateListingId: null,
      cloneListing: null,
      selectedListing: null,
      selectedListingId: null,
      selectedListingIndex: null,
      modalTitle: '',
      formId: null,
      api: apiRoutes, // refactor this later
      table: {},
      optionSelections: {},
      showSettings: false,
      showAdvanceFilters: false,
      showPSqm: false,
      isSelectedPropertyPreviewOpen: false,
      selectedListingForGenerateReport: [],
      selectedDivision: 1,
      searchQuery: null,
      listingsUrlParams: {
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
        user: null,
        city: null,
        location: null,
        priceMin: null,
        priceMax: null,
        priceSqmMin: null,
        priceSqmMax: null,
        floorAreaMin: null,
        floorAreaMax: null,
        lotAreaMin: null,
        lotAreaMax: null,
        suggestionModel: null,
        orderBy: 'id',
        order: 'desc',
      },
      displayStatus: null,
      contactDesignation: null,
      checkboxData: [],
      galleryId: null,
      sortedAreaName: null,
      sortedBuildingName: null,
      sortedContactName: null,
      sortedContactDesignationName: null,
      sortedCityNames: [],
      suggestions: [],
      suggestionBoxStatus: false,
      confirmDeleteAlert: {
        show: '',
        id: '',
        name: '',
      },
      autoShowAddForm: false,
      internalDesignation: [
        'administrator',
        'internal-broker',
        'listing-officer',
      ],
    }
  },
  computed: {
    divisionTitle() {
      //return `${this.selectedDivision} Viewing List`;
      let str = ''
      if ('divisions' in this.table) {
        const division = this.table.divisions.find(
          (item) => item.id == this.selectedDivision
        )
        str = division.name + ' Viewing List'
      }
      return str
    },
    hasSortArea() {
      return this.sortedAreaName !== null
    },
    hasSortBuilding() {
      return this.sortedBuildingName !== null
    },
    hasSortContact() {
      return this.sortedContactName !== null
    },
    hasSortContactDesignation() {
      return this.sortedContactDesignationName !== null
    },
    hasSortCity() {
      return this.sortedCityNames.length > 0
    },
    isSearching() {
      return (
        this.listingsUrlParams.search !== null &&
        this.listingsUrlParams.search.length > 0
      )
    },
  },

  watch: {
    showPSqm(newValue) {
      this.table.columns.price_psqm.is_visible = newValue
    },
  },

  methods: {
    sorting(values) {
      this.listingsUrlParams.orderBy = values.orderBy
      this.listingsUrlParams.order = values.order
      this.getListings()
    },
    resetListings() {
      this.getListings()
    },
    afterFetch() {
      this.table.columns.price_psqm.is_visible = this.showPSqm

      if (this.autoShowAddForm) {
        this.addListing()
        this.autoShowAddForm = false
      }
    },
    onDeckToggled() {
      this.fetch()
    },

    async fetch() {
      await showLoading()

      try {
        this.table = await this._getDeckListings(this.buildQueryParams())
        this.afterFetch()
      } catch (error) {
        showSwal({
          confirmButtonColor: '#3085d6',
          title: 'Something went wrong',
          html: 'Oops! Something went wrong fetching data. Please try again later.',
          icon: 'error',
          allowOutsideClick: false,
          confirmButtonText: 'Reload',
        }).then((result) => {
          if (result.isConfirmed) {
            window.location.reload()
          }
        })
      }
      dismissLoading()
    },
    async getListings() {
      await showLoading()
      try {
        this.table = await this._getListings(this.buildQueryParams())
        this.afterFetch()
      } catch (error) {
        // console.error(error)
      }
      dismissLoading()
    },
    async fetchOptionSelections() {
      this.optionSelections = await this._getSelection()
    },
    async fetchSuggestions(query) {
      const queryParams = this.buildQueryParams() + '&location_query=' + query
      this.suggestions = await this._getSuggestions(queryParams)
      this.suggestionBoxStatus = true
    },
    activeDivision(division) {
      return this.selectedDivision == division
        ? 'pt-0.5 border-b-2 border-primary'
        : ''
    },

    getThumbnailUrl(row) {
      return
    },

    changeDivisionTab(division) {
      if (division == this.selectedDivision) {
        return true
      }
      this.selectedListingForGenerateReport = []
      this.listingsUrlParams.division = division
      this.selectedDivision = division
      this.getListings()
    },
    initiateSearch(listingsUrlParams) {
      this.listingsUrlParams.search = listingsUrlParams.search
      this.getListings()
    },

    searchCallback(listingsUrlParams) {
      this.listingsUrlParams.searchColumn = listingsUrlParams.searchColumn
      this.listingsUrlParams.category = listingsUrlParams.category
      this.listingsUrlParams.type = listingsUrlParams.type
      this.listingsUrlParams.condition = listingsUrlParams.condition
      this.listingsUrlParams.availability = listingsUrlParams.availability
      this.listingsUrlParams.search = listingsUrlParams.search
      this.listingsUrlParams.bedroomMin = listingsUrlParams.bedroomMin
      this.listingsUrlParams.bedroomMax = listingsUrlParams.bedroomMax
      this.listingsUrlParams.priceMin = listingsUrlParams.priceMin
      this.listingsUrlParams.priceMax = listingsUrlParams.priceMax
      this.listingsUrlParams.priceSqmMin = listingsUrlParams.priceSqmMin
      this.listingsUrlParams.priceSqmMax = listingsUrlParams.priceSqmMax
      this.listingsUrlParams.parking = listingsUrlParams.parking
      this.listingsUrlParams.floorAreaMin = listingsUrlParams.floorAreaMin
      this.listingsUrlParams.floorAreaMax = listingsUrlParams.floorAreaMax
      this.listingsUrlParams.lotAreaMin = listingsUrlParams.lotAreaMin
      this.listingsUrlParams.lotAreaMax = listingsUrlParams.lotAreaMax
      this.getListings()
      this.$refs.advanceFiltersModal.toggleModal()
    },

    addSortCity(city) {
      if (!this.sortedCityNames.includes(city)) {
        this.sortedCityNames.push(city)
        this.listingsUrlParams.city =
          this.sortedCityNames.length > 0
            ? this.sortedCityNames.join(' ')
            : null
        this.getListings()
      }
    },

    sortCity(listing) {
      this.addSortCity(listing.city?.name ?? listing.city_name)
    },

    sortArea(listing) {
      this.listingsUrlParams.area = listing.area_name
      this.sortedAreaName = listing.area_name
      this.getListings()
    },

    sortBuilding(listing) {
      this.listingsUrlParams.building = listing.building_name
      this.sortedBuildingName = listing.building_name
      this.getListings()
    },

    sortContact(listing) {
      this.listingsUrlParams.user = listing.contact_id
      this.sortedContactName = listing.user_name
      this.getListings()
    },

    sortContactDesignation(listing) {
      this.listingsUrlParams.designation = listing.user_designation_id
      this.sortedContactDesignationName = listing.user_designation
      this.contactDesignation = listing.user_designation_id
      this.getListings()
    },

    resetSearch() {
      this.searchQuery = null
      this.sortedAreaName = null
      this.sortedBuildingName = null
      this.sortedCityNames = []
      this.displayStatus = null
      this.contactDesignation = null
      this.listingsUrlParams.isOnline = null
      this.listingsUrlParams.designation = null
      this.listingsUrlParams.page = null
      this.listingsUrlParams.search = ''
      this.listingsUrlParams.building = null
      this.listingsUrlParams.area = null
      this.listingsUrlParams.city = null
      this.listingsUrlParams.searchColumn = 'id'
      this.suggestionBoxStatus = false
      this.getListings()
    },

    resetSort(item) {
      if (item == 'contact') {
        this.listingsUrlParams.user = null
        this.sortedContactName = null
      } else if (item == 'contact_designation') {
        this.listingsUrlParams.designation = null
        this.sortedContactDesignationName = null
        this.contactDesignation = null
      } else if (item == 'building') {
        this.listingsUrlParams.building = null
        this.sortedBuildingName = null
      } else if (item == 'area') {
        this.listingsUrlParams.area = null
        this.sortedAreaName = null
      }

      this.getListings()
    },

    resetSortCity(city) {
      this.sortedCityNames = this.sortedCityNames.filter(
        (value) => value != city
      )
      this.listingsUrlParams.city =
        this.sortedCityNames.length > 0 ? this.sortedCityNames.join(' ') : null
      this.getListings()
    },

    displayStatusInput(listingsUrlParams) {
      this.listingsUrlParams.isOnline = listingsUrlParams.isOnline
      this.getListings()
    },
    contactDesignationInput(listingsUrlParams) {
      this.listingsUrlParams.designation = listingsUrlParams.designation
      this.sortedContactDesignationName = null // reset sorted contact designation
      this.getListings()
    },
    suggestionsInput(value) {
      if (this.listingsUrlParams.searchColumn == 'location') {
        this.addSortCity(value)
        this.suggestionBoxStatus = false
      } else {
        this.listingsUrlParams['search'] = value
        this.listingsUrlParams['page'] = null
        this.suggestionBoxStatus = false
        this.suggestions = []
        this.getListings()
      }
    },
    searchColumnsInput(listingsUrlParams) {
      this.searchQuery = null
      this.listingsUrlParams['search'] = ''
      this.listingsUrlParams.searchColumn = listingsUrlParams.searchColumn
      this.getListings()
    },
    buildQueryParams() {
      let params = []
      for (const [key, value] of Object.entries(this.listingsUrlParams)) {
        if (value !== null) {
          params.push(`${key}=${value}`)
        }
      }
      return '?' + params.join('&')
    },
    async changePage(data) {
      const { label, url } = data
      if (!url) {
        return true
      }
      const urlEncoded = new URL(url)
      let page = urlEncoded.searchParams.get('page')
      page = parseInt(page, 10)
      this.listingsUrlParams.page = await page
      this.getListings()
    },

    // emitted event
    addListingFromGenerateReport(listing) {
      this.selectedListingForGenerateReport.push(listing)
      this.checkboxData.push(listing.id)
    },

    removeListingFromGenerateReport(id) {
      this.selectedListingForGenerateReport =
        this.selectedListingForGenerateReport.filter((l) => l.id !== id)
      this.removeCheckBox(id)
    },

    addCheckBox(event, listing) {
      if (event.target.checked) {
        this.selectedListingForGenerateReport.push(listing)
      } else {
        this.selectedListingForGenerateReport =
          this.selectedListingForGenerateReport.filter(
            (l) => l.id !== listing.id
          )
      }
    },

    removeCheckBox(id) {
      this.checkboxData = this.checkboxData.filter(
        (listingId) => listingId !== id
      )
    },

    showAllColumns(show = true) {
      Object.keys(this.table.columns).forEach((column, index) => {
        this.toggleColumn(index, show)
        this.table.columns[column]['is_visible'] = show
      })
    },
    toggleColumn(colIndex, status) {
      const tbl = document.getElementById('listingTable')
      const length = tbl.getElementsByTagName('tr').length

      for (let i = 0; i < length; i++) {
        const col = tbl.getElementsByTagName('tr')[i].children[colIndex]
        col.style.display = status ? '' : 'none'
      }
    },
    columnChecked(column) {
      const keys = Object.keys(this.table.columns)
      const index = keys.indexOf(column)

      this.table.columns[column]['is_visible'] =
        !this.table.columns[column]['is_visible']
      this.toggleColumn(index, this.table.columns[column]['is_visible'])
    },
    resetAdvanceFilters() {
      this.tableUrlParameters['category'] = null
      this.tableUrlParameters['type'] = null
      this.tableUrlParameters['condition'] = null
      this.tableUrlParameters['availability'] = null
      this.tableUrlParameters['priceMin'] = null
      this.tableUrlParameters['priceMax'] = null
      this.tableUrlParameters['priceSqmMin'] = null
      this.tableUrlParameters['priceSqmMax'] = null
      this.tableUrlParameters['floorAreaMin'] = null
      this.tableUrlParameters['floorAreaMax'] = null
      this.tableUrlParameters['lotAreaMin'] = null
      this.tableUrlParameters['lotAreaMax'] = null
      this.getListings()
    },
    advanceFilterCallback: debounce(function (key, value) {
      this.tableUrlParameters[key] = value
      this.fetchTableData()
    }, 300),

    async changeListingOnlineStatus(index, id, isOnline) {
      await showLoading()
      try {
        const { success } = await this._changeListingOnlineStatus(id, isOnline)
        if (success) {
          this.getListings()
          // this.table.data[index].is_online = isOnline
        }
      } catch (error) {
        showToast({
          title: 'Something went wrong updating status. Please try again.',
          icon: 'warning',
        })
      }
      dismissLoading()
    },
    isUserHasPermission(key) {
      return this._isUserHasPermission(key)
    },
    async setAmenityHasBalcony(listing, index) {
      await showLoading()
      try {
        const { success } = await this._setAmenity(
          listing.id,
          'balcony',
          !listing.has_balcony
        )
        if (success) {
          //this.getListings();
          this.table.data[index].has_balcony = !listing.has_balcony
        }
      } catch (error) {
        showToast({
          title: 'Something went wrong. Please try again.',
          icon: 'warning',
        })
      }
      dismissLoading()
    },
    async setAmenityPetFriendly(listing, index) {
      await showLoading()
      try {
        const { success } = await this._setAmenity(
          listing.id,
          'pet-friendly',
          !listing.are_pets_allowed
        )
        if (success) {
          //this.getListings();
          this.table.data[index].are_pets_allowed = !listing.are_pets_allowed
        }
      } catch (error) {
        showToast({
          title: 'Something went wrong. Please try again.',
          icon: 'warning',
        })
      }
      dismissLoading()
    },
    openSingleListing(id) {
      this.$router.push({
        path: `/listing/${id}`,
      })
    },

    openGalleryModal(listing) {
      if (!listing.media_count) return true
      this.selectedListingId = listing.id
      this.$refs.galleryModal.toggleModal()
    },

    addListing() {
      this.updateListingId = null
      this.modalTitle = 'Add Listing'
      this.$refs.listingModal.toggleModal()
    },

    showUpdateListing(updateListing) {
      this.updateListingId = updateListing
      this.modalTitle = 'Update Listing'
      this.$refs.listingModal.toggleModal()
    },

    showCloneListing(listing) {
      this.cloneListing = listing
      this.$refs.listingCloneModal.toggleModal()
    },

    showRemarksModal(selected) {
      this.selectedListing = selected
      this.$refs.listingRemarksModal.toggleModal()
    },

    showQuickUpdateModal(listing, index) {
      this.selectedListing = listing
      this.selectedListingIndex = index
      this.$refs.listingQuickUpdateModal.toggleModal()
    },

    /**
     * callback from Add listing modal
     */
    afterAddListing() {
      this.getListings()
      this.$refs.listingModal.toggleModal()

      if (this.updateListingId) {
        this.showLogForm(this.updateListingId)
      }
    },

    afterCloneListing() {
      this.$refs.listingCloneModal.toggleModal()
      setTimeout(() => {
        this.getListings()
      }, 1000)
    },

    closeRemarksModal(remarks) {
      this.selectedListing.remarks = remarks
      this.$refs.listingRemarksModal.toggleModal()
      this.showLogForm(this.selectedListing.id)
    },

    closeQuickUpdateModal(listing) {
      // pass the listing to update data pass in Table component
      // this is to update the table row display
      this.selectedListing = listing
      this.table.data[this.selectedListingIndex] = listing
      this.$refs.listingQuickUpdateModal.toggleModal()
      this.showLogForm(this.selectedListing.id)
    },

    formatMoney(value) {
      return value && value > 0 ? formatMoney(value) : '--'
    },

    showPropertyLogs(listing) {
      this.modalTitle = `History Logs - Property #${listing}`
      this.selectedListingId = listing
      this.$refs.logListModal.toggleModal()
    },

    showLogForm(listingId) {
      this.selectedListingId = listingId
      this.$refs.logFormModal.toggleModal()
    },

    closeLogFormModal() {
      this.selectedListingId = null
      this.$refs.logFormModal.toggleModal()
    },

    autoLoadModal() {
      const showForm = this.$route.query?.showform

      if (showForm == 'add') {
        this.autoShowAddForm = true
      }
    },
    // methods moved to ListingRowInfoCard component
    /*
        getThumbnail(thumbnail){
            return thumbnail == '' ? 'https://dummyimage.com/64x64/2f7eed/ffffff.jpg&text=No+Image' : thumbnail
        }
        
        getClass(status) {
            return status ? 'bg-success' : 'bg-destructive';
        },
        unitNumberWithBuilding(listing)
        {
            return listing.building_name 
                    ? 
                    `${listing.unit_number} - ${listing.building_name}`
                    :
                    listing.unit_number;            
        },
        */
  },

  mounted() {
    this.fetch()
    this.fetchOptionSelections()
    this.autoLoadModal()
  },
}
</script>

<style>
td {
  background: transparent !important;
}
</style>
