<template>
  <div class="-mr-2 sm:-mr-6 lg:-mr-8">
    <div class="flex w-full">
      <div class="flex-col flex-1 w-full pr-2 mb-8 sm:pr-6 lg:pr-8">
        <div class="flex mt-8 mb-6">
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
          <NuxtLink
            to="/dashboard"
            class="flex my-auto ml-3 rounded-lg w-39 h-9 bg-green hover:bg-green-dark"
          >
            <span class="w-full my-auto font-bold text-center text-white"
              >Add Seo</span
            >
          </NuxtLink>
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
              <template #id="data">
                <SeoActions
                  :value="data.data"
                  :seo="rows[data.index]"
                  @edit="edit"
                  @updated="refreshRows"
                  @deleted="refreshRows"
                />
              </template>
            </Table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import Tables from '~/mixins/tables'
import Account from 'vue-material-design-icons/Account.vue'
import Dropdown from '~/components/Dropdown'
import Magnify from 'vue-material-design-icons/Magnify.vue'
import Table from '~/components/tables/Table'
import TableCell from '~/components/tables/TableCell'
import TableFilter from '~/components/tables/Filter'
import { apiRoutes } from '~/contants'
import SeoActions from '~/components/pages/seo/SeoActions'

export default {
  head() {
    return {
      title: 'SEO | Housinginteractive.com.ph',
    }
  },
  middleware: ['auth'],
  mixins: [Tables],
  components: {
    Account,
    Dropdown,
    Magnify,
    Table,
    TableCell,
    TableFilter,
    SeoActions,
  },
  data() {
    return {
      designation: null,
      designations: [],
      refresh: false,
      url: apiRoutes['seo'],
    }
  },
}
</script>
