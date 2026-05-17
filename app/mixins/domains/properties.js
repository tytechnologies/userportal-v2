import debounce from "lodash/debounce";
import { apiRoutes } from "~/contants";

export default {
  data() {
    return {
      propertyOptions: []
    }
  },
  methods: {
    onFetchProperties(search, loading) {
      if (!! search) {
        loading(true);
        this.fetchProperties(loading, search, this);
      }
    },
    fetchProperties: debounce((loading, search, vm) => {
      vm.$axios.get(apiRoutes['listings'], {
        params : {
                // all: false,
            //filters: { search },
                search : search,
                searchColumn: 'location',
                division: vm.form.division_id
            }
      })
        .then(({data}) => {
          vm.propertyOptions = data['data'].map((row) => {
            //row = row[0];
            //row.display_name = `ID ${row.id} - ${row.display_name}`;
            row.display_name = `ID ${row.id} - ${row.unit_number}`;
            row.name = `ID ${row.id} - ${row.unit_number}`;
            return row;
          });
          loading(false);
        });
    }, 300),
    fetchProperty(id) {
      return this.$axios.get(apiRoutes['listings.show'].replace('/:id', `/${id}`));
    }
  }
}
