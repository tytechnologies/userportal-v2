import debounce from "lodash/debounce";
import { apiRoutes }  from '~/contants'

export default {
  data() {
    return {
      ownerOptions: []
    }
  },
  methods: {
    onFetchOwners(search, loading) {
      if (!!search) {
        loading(true);
        this.fetchOwners(loading, search, this);
      }
    },
    fetchOwners: debounce((loading, search, vm) => {
      vm.$axios.get(apiRoutes['contact.list'], {
        all: false,
        //filters: { search },
        //searchColumn: 'name',
        search : search
      })
        .then(({ data }) => {
          //vm.ownerOptions = data['rows'].map(row => row[0]);          
          vm.ownerOptions = data.data;
          loading(false);
        });
    }, 300),
    fetchAllOwners() {
        const vm = this;
        vm.$axios.get(apiRoutes['contact.list'])
            .then(({ data }) => {        
              vm.ownerOptions = data.data;
            });
    }
  }
}
