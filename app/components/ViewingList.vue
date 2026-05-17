<template>
  <div>
    <div class="flex w-full">
      <div class="flex-col flex-1 w-full">
        <div class="flex mt-1 mb-6">
          <!-- Search -->
          <div
            class="flex flex-1 h-12 px-3 py-2 bg-card border border-white rounded-lg hi-search focus-within:border-blue"
          >
            <Magnify class="w-6 h-6 my-auto mr-3 text-gray-401" />
            <input
              type="text"
              v-model="query"
              placeholder="Search"
              class="flex-1 my-auto font-bold border-0 focus:outline-none focus:shadow-none focus:ring-0 placeholder-gray-3"
            />
            <Dropdown
              :columns="visibleSearchableColumns"
              v-model="searchColumn"
            />
          </div>
        </div>

        <div class="space-y-4">
          <div class="mb-8 overflow-x-auto">
            <Table
              :columns="columns"
              :sorting-enabled="sortingEnabled"
              :sorts="sorts"
              :rows="rows"
              @sortBy="sortBy"
              @paginate="paginate"
              :paginationData="paginationData"
            >
              <template #url="data">
                <div>
                  <ul class="flex space-x-0.5" role="none">
                    <li>
                      <button
                        type="button"
                        title="download"
                        class="w-full h-6 px-2 text-sm text-left text-primary"
                        @click="download(data.data)"
                      >
                        <i class="fas fa-download"></i>
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        title="Delete"
                        class="w-full h-6 px-2 text-sm text-left text-primary"
                        @click="showRemoveResidentialAlert(data.data)"
                      >
                        <i class="fas fa-trash"></i>
                      </button>
                    </li>
                  </ul>
                </div>
              </template>
            </Table>
          </div>
        </div>
      </div>
    </div>
    <Alert
      v-model="removeResidentialAlert.isOpen"
      icon="success"
      @ok="deleteResidentialReport"
      confirm-button-text="Delete"
    >
      <div class="text-center">
        <h3 class="text-lg font-medium leading-6 text-foreground">
          Confirm Delete
        </h3>
        <p class="text-lg font-medium leading-6 text-muted-foreground/70">
          Do you really want to delete this?
        </p>
      </div>
    </Alert>
  </div>
</template>
<script>
import Tables from '~/mixins/tables'
import { apiRoutes } from '~/contants'
import Dropdown from '~/components/Dropdown'
import Magnify from 'vue-material-design-icons/Magnify.vue'
import Table from '~/components/tables/Table'
import TableCell from '~/components/tables/TableCell'
import TableFilter from '~/components/tables/Filter'
import Alert from '~/components/CustomAlert.vue'

import { dismissLoading, showLoading, showToast } from '~/helpers/helpers'

export default {
  props: ['selectedDivision'],
  middleware: ['auth'],
  components: { Alert, TableCell, TableFilter, Table, Magnify, Dropdown },
  mixins: [Tables],
  data() {
    return {
      url: apiRoutes['viewingList'],
      downloadGeneratedReport: apiRoutes['download.report'],
      deleteGeneratedReport: apiRoutes['delete.report'],
      removeResidentialAlert: {
        isOpen: false,
        data: [],
      },
      queryString: ['division'],
      division: 'residential',
    }
  },
  watch: {
    selectedDivision() {
      this.division = this.selectedDivision
      // this.fetch();
    },
  },

  methods: {
    showRemoveResidentialAlert(data) {
      this.removeResidentialAlert.isOpen = true
      this.removeResidentialAlert.data = data
    },
    deleteResidentialReport() {
      const { id } = this.removeResidentialAlert.data
      showLoading()
      this.$axios
        .$delete(this.deleteGeneratedReport.replace('/:id', `/${id}`))
        .then((res) => {
          dismissLoading()
          this.updateRows()
          showToast({ title: 'Removed successfully.' })
        })
        .catch(() => {
          dismissLoading()
          alert('Oops. Something went wrong. Please try again later.')
        })
    },
    download(data) {
      const { url, client_name } = data
      // console.log(data)
      showLoading()
      this.$axios
        .$post(
          this.downloadGeneratedReport,
          { url },
          { responseType: 'arraybuffer' }
        )
        .then((res) => {
          const filename = `Residential Viewing List for ${client_name}.docx`
          const downloadUrl = window.URL.createObjectURL(new Blob([res]))
          const link = document.createElement('a')
          link.href = downloadUrl
          link.setAttribute('download', filename)
          document.body.appendChild(link)
          link.click()
          link.remove()
          dismissLoading()
          showToast({ title: 'Downloading please wait...' })
        })
        .catch(() => {
          dismissLoading()
          alert('Oops. Something went wrong. Please try again later.')
        })
    },
  },
}
</script>
