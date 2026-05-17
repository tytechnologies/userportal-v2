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
              class="mr-8 text-xs font-bold sm:text-sm md:text-sm lg:text-sm h-14"
              @click="changeDivisionTab('Viewing Lists')"
              :class="activeDivision('Viewing Lists')"
            >
              Viewing Lists
            </button>

            <button
              class="mr-8 text-xs font-bold sm:text-sm md:text-sm lg:text-sm h-14"
              @click="changeDivisionTab('Authority to Sell')"
              :class="activeDivision('Authority to Sell')"
            >
              Authority to Sell
            </button>

            <button
              class="mr-8 text-xs font-bold sm:text-sm md:text-sm lg:text-sm h-14"
              @click="changeDivisionTab('Contract Of Lease')"
              :class="activeDivision('Contract Of Lease')"
            >
              Contract of Lease
            </button>
          </div>
        </nav>

        <div
          class="flex mt-4 mb-6 xs:flex-col sm:flex-col md:flex-col lg:flex-row"
        >
          <!-- Search -->
          <div
            class="flex justify-between flex-1 px-3 py-2 mb-2 bg-card border border-white rounded-lg hi-search focus-within:border-blue"
          >
            <div class="flex items-center w-full">
              <font-awesome-icon
                icon="magnifying-glass"
                class="mt-1 mr-3 text-muted-foreground"
              />
              <div class="relative w-full">
                <input
                  type="text"
                  placeholder="Search"
                  class="flex-auto w-full my-auto font-bold border-0 focus:outline-none focus:shadow-none focus:ring-0 placeholder-gray-3"
                  v-model="urlParams.search"
                  v-on:input="search"
                />
              </div>
            </div>

            <div class="flex items-center gap-2">
              <span
                class="cursor-pointer mr-2 w-8 h-8 text-center pt-1.5 bg-muted inline-block rounded-lg"
                title="Reset Search"
                @click="resetSearch"
              >
                <font-awesome-icon icon="recycle" />
              </span>
              <Dropdown
                :columns="table.searchColumns"
                v-model="urlParams.searchColumn"
                v-on:input="fetch"
              />
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <div class="">
            <ListingsTable :table="table">
              <tr
                v-for="(row, index) in table.data"
                :key="index"
                class="transition duration-300 ease-in-out bg-card"
              >
                <!-- Name -->
                <td
                  class="p-2 border-solid rounded-r-2xl rounded-l-2xl sm:rounded-r-none md:rounded-r-none lg:rounded-r-none border-border border-b-6 border-t-6 h-14 min-w-36"
                >
                  <div
                    class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                  >
                    <p>
                      {{ row.author_name }}
                    </p>
                  </div>
                  <!--
                                <div class="flex gap-1 mt-4 sm:hidden md:hidden lg:hidden">
                                    <button v-if="isUserHasPermission('contacts.upsert')" type="button" title="Edit Contact"
                                    class="w-full h-6 px-2 text-sm text-left text-primary" @click="showContactForm('edit', row)">
                                    <font-awesome-icon icon="pen-to-square" />
                                    </button>

                                    <button type="button" title="Show Notes" v-if="row.notes"
                                    class="w-full h-6 text-sm text-left text-primary" @click="showNotes(row.notes)">
                                    <font-awesome-icon icon="circle-info" />
                                    </button>
                                    
                                    <button v-if="isUserHasPermission('contacts.delete')" type="button" title="Delete Contact"
                                    class="w-full h-6 px-2 text-sm text-left text-primary"
                                    @click="showConfirmDelete(row.id, row.name, index)">
                                    <font-awesome-icon icon="trash" />
                                    </button>
                                </div>
                                -->
                </td>

                <!-- Designation -->
                <td
                  class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell"
                >
                  <div
                    class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                  >
                    <p>
                      {{ row.client_name }}
                    </p>
                  </div>
                </td>

                <td
                  class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell"
                >
                  <div
                    class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                  >
                    <p class="col-locations ellipsis">
                      {{ row.locations }}
                    </p>
                  </div>
                </td>

                <td
                  class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell"
                >
                  <div
                    class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                  >
                    <p class="col-buildings ellipsis">
                      {{ row.buildings }}
                    </p>
                  </div>
                </td>

                <!-- Email -->
                <td
                  class="hidden py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell"
                >
                  <div
                    class="flex items-center h-full pr-2 whitespace-no-wrap border-r-1"
                  >
                    <p>
                      {{ row.created_at }}
                    </p>
                  </div>
                </td>

                <!-- Actions -->
                <td
                  class="hidden py-2 pl-2 pr-4 border-solid rounded-r-2xl border-border border-b-6 border-t-6 sm:table-cell md:table-cell lg:table-cell"
                >
                  <div class="flex">
                    <button
                      v-if="isUserHasPermission('contacts.upsert')"
                      type="button"
                      title="Download Report"
                      class="h-6 px-2 text-sm text-left text-primary"
                      @click="download(row.download_url)"
                    >
                      <font-awesome-icon icon="download" />
                    </button>

                    <button
                      v-if="isUserHasPermission('contacts.delete')"
                      type="button"
                      title="Delete Report"
                      class="h-6 px-2 text-sm text-left text-primary"
                      @click="deleteDocumentConfirm(row.id)"
                    >
                      <font-awesome-icon icon="trash" />
                    </button>
                  </div>
                </td>
              </tr>
            </ListingsTable>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import debounce from 'lodash/debounce'
import documentService from '@/services/document.services'
import authService from '@/services/auth.services'
import { apiRoutes } from '~/contants'
import Swal from 'sweetalert2'
import {
  faDownload,
  faMagnifyingGlass,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import { library } from '@fortawesome/fontawesome-svg-core'

import {
  dismissLoading,
  showLoading,
  showToast,
  showSwal,
} from '@/helpers/helpers'

import Dropdown from '~/components/Dropdown'
import ListingsTable from '@/components/ListingsTable.vue'
import TableFilter from '@/components/tables/Filter'

library.add(faDownload, faXmark, faMagnifyingGlass)

export default {
  middleware: ['auth'],
  mixins: [authService, documentService],
  components: {
    Dropdown,
    ListingsTable,
    TableFilter,
  },
  data() {
    return {
      table: {},
      api: apiRoutes,
      urlParams: {
        searchColumn: 'client',
        page: null,
        search: null,
        division: 'commercial',
        document_type: 'Viewing Lists',
      },
    }
  },
  computed: {
    isSearching() {
      return this.urlParams.search !== null && this.urlParams.search.length > 0
    },
  },
  watch: {
    /*
            formId(value) {
                if (value === null) {
                    // this.refreshRows();
                    this.contact = null;
                }
            }
            */
  },
  methods: {
    async fetch() {
      await showLoading()
      try {
        this.table = await this._getDocuments(this.buildQueryParams())
      } catch (error) {
        // console.error(error)
      }
      dismissLoading()
    },

    search: debounce(function (e) {
      this.urlParams['page'] = null
      this.fetch()
    }, 300),

    resetSearch() {
      this.urlParams.designation = null
      this.urlParams.search = null
      this.urlParams.page = null
      this.fetch()
    },

    isUserHasPermission(key) {
      return this._isUserHasPermission(key)
    },

    changeDivisionTab(documentType) {
      if (documentType == this.urlParams.document_type) {
        return true
      }
      this.urlParams.document_type = documentType
      this.fetch()
    },

    activeDivision(documentType) {
      return this.urlParams.document_type == documentType
        ? 'pt-0.5 border-b-2 border-blue'
        : ''
    },

    async changePage(data) {
      const { label, url } = data
      if (!url) {
        return true
      }
      const urlEncoded = new URL(url)
      let page = urlEncoded.searchParams.get('page')
      page = parseInt(page, 10)
      this.urlParams.page = await page
      this.fetch()
    },

    buildQueryParams() {
      let params = []
      for (const [key, value] of Object.entries(this.urlParams)) {
        if (value !== null) {
          params.push(`${key}=${value}`)
        }
      }
      return '?' + params.join('&')
    },

    download(url) {
      const link = document.createElement('a')
      link.href = url
      link.click()
      link.remove()
      dismissLoading()
      showToast({ title: 'Downloading please wait...' })
    },

    deleteDocumentConfirm(id) {
      showSwal({
        confirmButtonColor: '#E73F31',
        title: 'Delete Document',
        html: `Are you sure you want to delete the document?`,
        icon: 'error',
        allowOutsideClick: false,
        confirmButtonText: 'Delete',
        showCancelButton: true,
      }).then((result) => {
        if (result.isConfirmed) {
          this.deleteDocument(id)
        }
      })
    },

    deleteDocument(id) {
      let deleteGeneratedReportUrl = apiRoutes['documents.delete']
      showLoading()
      this.$axios
        .$delete(deleteGeneratedReportUrl.replace('/:id', `/${id}`))
        .then((res) => {
          dismissLoading()
          this.fetch()
          showToast({ title: 'Removed successfully.' })
        })
        .catch(() => {
          dismissLoading()
          showToast({
            title: 'Oops. Something went wrong. Please try again later.',
          })
        })
    },
  },

  mounted() {
    this.fetch()
  },
}
</script>
