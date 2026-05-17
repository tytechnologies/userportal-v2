<template>
  <div>
    <div class="align-middle min-w-full overflow-x-hidden overflow-hidden">
      <table id="datatable" ref="table" class="min-w-full mb-2">
        <colgroup>
          <col v-for="column in columns" :key="column.column" />
        </colgroup>
        <thead>
          <tr class="bg-muted">
            <th v-for="column in columns" :key="column.column">
              <span
                v-if="!(sortingEnabled && column.sortable)"
                class="w-full text-sm text-center font-normal px-1 pt-1.5 pb-0.25 whitespace-nowrap mt-auto"
                v-html="column.text"
              ></span>
              <span
                v-else
                @click="$emit('sortBy', column.column)"
                class="w-full justify-between flex text-sm focus:outline-none px-2 pt-1.5 pb-0.25"
              >
                <div
                  class="mr-4 whitespace-nowrap my-auto"
                  v-html="column.text"
                ></div>
                <div class="cursor-pointer">
                  <ChevronUp
                    v-if="
                      sorts[column.column] && sorts[column.column] === 'asc'
                    "
                    class="w-6 h-6 my-auto"
                  />
                  <ChevronDown
                    v-else-if="
                      sorts[column.column] && sorts[column.column] === 'desc'
                    "
                    class="w-6 h-6 my-auto"
                  />
                  <SortVariant v-else class="w-6 h-6" />
                </div>
              </span>
            </th>
          </tr>
        </thead>
        <tbody class="bg-card">
          <tr
            v-for="(row, rowIndex) in formattedRows"
            :class="{ 'bg-muted/40': rowIndex % 2 }"
            class="border-b border-border"
            :key="rowIndex"
          >
            <td v-for="(cell, cellIndex) in row" :key="cellIndex">
              <template v-if="$scopedSlots[cell.column]">
                <slot :name="cell.column" :data="cell.value" />
              </template>
              <TableCell v-else :value="cell.value"></TableCell>
            </td>
          </tr>
          <tr
            class="border-b border-border text-center"
            v-if="!(formattedRows && formattedRows.length)"
          >
            <td :colspan="columns.length" class="font-semibold py-2">
              No listings to display
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="bg-card flex items-center justify-between p-4">
      <div class="flex-1 flex justify-between sm:hidden">
        <a
          href="#"
          class="relative inline-flex items-center px-4 py-1 border border-border text-sm font-medium rounded-md text-foreground bg-card hover:bg-accent hover:text-accent-foreground"
        >
          Previous
        </a>
        <a
          href="#"
          class="ml-3 relative inline-flex items-center px-4 py-1 border border-border text-sm font-medium rounded-md text-foreground bg-card hover:bg-accent hover:text-accent-foreground"
        >
          Next
        </a>
      </div>
      <div class="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
        <div>
          <p class="text-sm text-foreground">
            Showing <span class="font-medium">{{ pagination.from }}</span>
            to
            <span class="font-medium">{{ pagination.to }}</span>
            of
            <span class="font-medium">{{ pagination.total }}</span>
            results
          </p>
        </div>
        <div>
          <nav
            class="relative z-0 inline-flex rounded-md shadow-sm -space-x-px"
            aria-label="Pagination"
          >
            <a
              aria-current="page"
              v-for="(link, index) in pagination.links"
              :key="index"
              @click="pageClicked(link)"
              class="z-10 relative inline-flex items-center px-3 py-1 border border-border text-sm font-medium cursor-pointer hover:bg-muted"
              :class="{
                'bg-muted/40': link.active,
                'rounded-l-md': index === 0,
                'rounded-r-md': index + 1 === pagination.links.length,
              }"
              v-html="link.label"
            ></a>
          </nav>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import ColumnResizer from 'column-resizer'
import ChevronDown from 'vue-material-design-icons/ChevronDown.vue'
import ChevronUp from 'vue-material-design-icons/ChevronUp.vue'
import SortVariant from 'vue-material-design-icons/SortVariant.vue'
import TableCell from './TableCell'

export default {
  props: [
    'columns',
    'sortingEnabled',
    'sorts',
    'rows',
    'paginationData',
    'columnSettings',
  ],
  components: { ChevronDown, ChevronUp, SortVariant, TableCell },
  data() {
    return {
      formattedRows: this.formatRows(this.rows),
      pagination: [],
    }
  },
  watch: {
    rows(value) {
      this.disableResize()
      this.formattedRows = this.formatRows(value)
      setTimeout(() => {
        this.enableResize()
      }, 300)
    },
    paginationData(value) {
      this.pagination = value
    },
  },
  mounted() {
    this.enableResize()
  },
  methods: {
    pageClicked(link) {
      this.$emit('paginate', link)
      this.$emit('paginateCallback', link)
    },
    formatRows(rows) {
      return rows.map((row) => {
        return this.columns
          .filter((column) => !column.hidden)
          .map((column, index) => {
            return {
              asHtml: column.asHtml,
              column: column.column,
              value: row[index],
            }
          })
      })
    },
    enableResize() {
      const options = { resizeMode: 'overflow', liveDrag: true }
      if (!this.resizer) {
        this.resizer = new ColumnResizer(this.$refs['table'], options)
      } else {
        this.resizer.reset(options)
      }
    },
    disableResize() {
      if (this.resizer) {
        this.resizer.reset({ disable: true })
      }
    },
  },
}
</script>
