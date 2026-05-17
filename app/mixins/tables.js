import debounce from "lodash/debounce";
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers';
export default {
  data() {
    return {
      columns: [],
      columnSettings: {},
      filters: {},
      queryString: [],
      rows: [],
      searchableColumns: {},
      searchColumn: '',
      singleColumnSorting: false,
      sortingEnabled: true,
      sorts: {},
      url: null,
      watchables: [],
      paginationData: [],
      queryWatch: null,
      watchablesWatch: null,
      stopwatching: false,
      queryDebounce: null,
      query: '',
      page: 0,
      params: {}

    }
  },
  
  watch: {
    url() {
      this.fetch();
    },
    searchColumn() {
      this.fetch();
    },
    query() {
      clearTimeout(this.queryDebounce);
      this.queryDebounce = setTimeout(() => {
        this.fetch();
      }, 500);
    },
  },
  
  computed: {
    visibleSearchableColumns() {
      const columns = {};
      Object.keys(this.searchableColumns).forEach((key) => {
        const value = this.searchableColumns[key];
        if (typeof value === 'string' || typeof value['is_visible'] === 'undefined' || value['is_visible']) {
          columns[key] = value;
        }
      });
      return columns;
    }
  },
  created() {
    //this.fetch();
  },
  methods: {
    fetch() {
      showLoading();
      this.params = {};
      this.queryString.forEach((key) => {
        if (this[key] !== null) {
          this.params[key] = this[key];
        }
      });

      if (this.query) this.params['filters[search]'] = this.query;

      if (this.searchColumn) this.params['searchColumn'] = this.searchColumn;

      Object.keys(this.sorts).forEach(key => {
        if (this.sorts[key] !== null) {
          this.params[`sorts[${key}]`] = this.sorts[key];
        }
      });

      this.params[`columnSetting`] = true;

      this.$axios.get(this.url, { params: this.params }).then(({ data }) => {
        dismissLoading();

        Object.keys(data).forEach((key) => {
          this[key] = data[key];
        });

        this.queryString = data['queryString'];


        data['queryString'].forEach((key) => {
          this.queryWatch = this.$watch(key, (value) => {
            clearTimeout(this.queryDebounce);
            this.queryDebounce = setTimeout(() => {
              if (key === 'searchColumn') {
                this.searchColumn = value;
              }
              this.fetch();
            }, 500)
          }, { deep: true });
        });

        this.watchables.forEach((key) => {
          this.queryWatch = this.$watch(key, (value) => {
            clearTimeout(this.searchQueryDebounce);
            this.searchQueryDebounce = setTimeout(() => {
              // this.fetch();
            }, 1000)
          }, { deep: true });
        });

      }, () => {
        showToast({ title: 'Something went wrong', icon: 'error' });
        dismissLoading();
      });
    },
    resetParams() {
      this.query = '';
      this.page = 0;
      this.params['page'] = 0;
    },
    paginate(data) {
      const { url } = data;
      if (url) this.url = url;
    },
    sortBy(column) {
      if (!this.sortingEnabled) {
        return;
      }

      let sorts = Object.assign({}, this.sorts);

      if (this.singleColumnSorting && Object.keys(this.sorts).length > 0 && !this.sorts[column]) {
        sorts = {};
      }

      if (!this.sorts[column]) {
        sorts[column] = 'asc';
      }
      else if (this.sorts[column] === 'asc') {
        sorts[column] = 'desc';
      }
      else {
        delete sorts[column];
      }

      this.sorts = sorts;

      this.fetch();
    },
    showAllColumns(show = true) {
      Object.keys(this.columnSettings).forEach((column, index) => {
        this.toggleColumn(index, show);
        this.columnSettings[column]['is_visible'] = show;
      });
    },

    columnChecked(column) {
      const index = this.columns.findIndex(object => {
        return object.column === column;
      });

      this.columnSettings[column]['is_visible'] = !this.columnSettings[column]['is_visible'];
      this.toggleColumn(index, this.columnSettings[column]['is_visible']);

    },
    toggleColumn(colIndex, status) {
      var tbl = document.getElementById('datatable');
      var col = tbl.getElementsByTagName('col')[colIndex];
      if (col) {
        col.style.visibility = status ? "" : "collapse";
      }
    },
    dataChanged(key, value) {
      this[key] = value;
    },

    refreshRows() {
      this.fetch();
    }

  }
}
