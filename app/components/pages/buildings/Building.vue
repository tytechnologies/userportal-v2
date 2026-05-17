<template>
  <aside class="sticky top-0 flex flex-col h-screen px-4 py-6 bg-card w-120">
    <div class="flex">
      <h5 class="mt-1 font-bold">Building Details</h5>
      <button
        type="button"
        class="w-6 h-6 my-auto ml-auto text-center rounded-full bg-muted hover:bg-muted"
        @click="close"
      >
        <span
          class="block w-4 h-4 mx-auto opacity-50 hover:text-foreground hover:opacity-100"
        >
          <Close class="opacity-inherit" :size="16" />
        </span>
      </button>
    </div>
    <hr class="mt-4 mb-9 border-border" />
    <div class="relative text-center">
      <h3 class="text-2xl font-bold text-foreground">
        {{ data['building.name'] }}
      </h3>
      <div
        class="absolute right-0 inline-block mr-2 text-left"
        v-on-clickaway="hideActions"
        v-if="
          userHasPermissionTo('buildings.upsert') ||
          userHasPermissionTo('buildings.delete')
        "
      >
        <button
          type="button"
          aria-expanded="true"
          aria-haspopup="true"
          @click="showActions = true"
          class="w-8 h-8 my-auto ml-4 rounded-full"
          :class="
            showActions
              ? 'bg-primary/10 hover:bg-primary/10'
              : 'bg-muted hover:bg-muted'
          "
        >
          <span
            class="block w-6 h-6 mx-auto"
            :class="
              showActions
                ? 'text-primary'
                : 'opacity-50 hover:text-foreground hover:opacity-100'
            "
          >
            <DotsVertical class="mx-auto opacity-inherit" />
          </span>
        </button>
        <transition
          enter-active-class="transition duration-100 ease-out"
          enter-from-class="transform scale-95 opacity-0"
          enter-to-class="transform scale-100 opacity-100"
          leave-active-class="transition duration-75 ease-in"
          leave-from-class="transform scale-100 opacity-100"
          leave-to-class="transform scale-95 opacity-0"
        >
          <div
            class="absolute right-0 z-10 w-24 mt-2 origin-top-right bg-card rounded-md shadow-lg focus:outline-none"
            role="menu"
            aria-orientation="vertical"
            aria-labelledby="menu-button"
            tabindex="-1"
            v-show="showActions"
          >
            <ul class="py-1" role="none">
              <li class="pt-1.5 pb-0.5 hover:bg-muted">
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="edit"
                  v-if="userHasPermissionTo('buildings.upsert')"
                >
                  Edit
                </button>
              </li>
              <li class="pt-1.5 pb-0.5 hover:bg-muted">
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="confirmDelete"
                  v-if="userHasPermissionTo('buildings.delete')"
                >
                  Delete
                </button>
              </li>
            </ul>
          </div>
        </transition>
      </div>
    </div>
    <div class="text-center mb-9">
      <span class="inline-block text-sm font-medium text-gray-3"
        >ID {{ data.id }}</span
      >
      <!--      <span class="relative inline-block w-4 h-4 rounded-md top-1" :class="true ? 'bg-green' : 'bg-muted'"></span>-->
    </div>
    <!-- <div class="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-black-10 scrollbar-thumb-rounded-full mb-9">
      <div class="mb-6">
        <p class="h-12 px-4 py-3 text-lg font-bold rounded-lg bg-muted/50">Class</p>
        <p class="h-12 px-4 py-3 font-medium rounded-lg text-foreground">Class A</p>
      </div>
    </div> -->
    <div
      class="flex-1 mb-6 overflow-y-auto scrollbar-thin scrollbar-thumb-black-10 scrollbar-thumb-rounded-full"
    >
      <table class="w-full table-fixed">
        <tbody class="divide-y-8 divide-white">
          <tr v-for="(row, index) in rows" :key="index" class="w-6">
            <th class="text-left">{{ index }}</th>
            <td v-if="index !== 'Amenities'">{{ row }}</td>
            <td v-if="index === 'Amenities'" v-html="row"></td>
          </tr>
        </tbody>
      </table>
    </div>
    <Alert
      v-model="showDeleteConfirmation"
      icon="success"
      @ok="destroy"
      confirm-button-text="Delete"
    >
      <div class="text-center">
        <h3 class="text-lg font-medium leading-6 text-foreground">
          Do you really want to delete building?
        </h3>
        <p class="text-lg font-medium leading-6 text-muted-foreground/70">
          {{ data.name }}
        </p>
      </div>
    </Alert>
  </aside>
</template>

<script>
import Auth from '~/mixins/auth'
import Account from 'vue-material-design-icons/Account.vue'
import Alert from '~/components/CustomAlert.vue'
import Close from 'vue-material-design-icons/Close.vue'
import DotsVertical from 'vue-material-design-icons/DotsVertical.vue'
import { apiRoutes } from '~/contants'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'

export default {
  head() {
    return {
      title: 'Buildings | Housinginteractive.com.ph',
    }
  },
  mixins: [Auth],
  props: ['value'],
  components: { Account, Alert, Close, DotsVertical },
  data() {
    return {
      data: {},
      showActions: false,
      showDeleteConfirmation: false,
    }
  },
  computed: {
    rows() {
      if (!this.value || Object.keys(this.data).length === 0) {
        return []
      }

      const rows = {
        Name: this.data['building.name'] || '--',
        Street: this.data['building.street'] || '--',
        Slug: this.data['building.slug'] || '--',
        Description: this.data['building.description'] || '--',
        Year: this.data['building.year_built'] || '--',
        Class: this.data['building.class'] || '--',
        Developer: this.data['building.developer.name'] || '--',
        Division: this.data['division.name'] || '--',
        Area: this.data['area.name'] || '--',
        City: this.data['city.name'] || '--',
      }

      if (this.data.amenities.length) {
        let amenities = ''
        this.data.amenities.forEach((amenity) => {
          amenities += `• ${amenity.name} <br>`
        })
        rows['Amenities'] = amenities
      }

      return rows
    },
  },
  watch: {
    async value(value) {
      if (!!value) {
        await showLoading()
        this.$axios
          .$get(apiRoutes['buildings.show'].replace('/:id', `/${value}`))
          .then((data) => {
            dismissLoading()
            this.data = data
            this.data['id'] = value
          })
      } else {
        this.data = {}
      }
    },
  },
  methods: {
    close() {
      this.$emit('close')
    },
    hideActions() {
      this.showActions = false
    },
    edit() {
      this.$emit('edit', this.value)
      this.hideActions()
    },
    confirmDelete() {
      this.showDeleteConfirmation = true
      this.hideActions()
    },
    destroy() {
      this.showDeleteConfirmation = false
      this.$axios
        .$delete(
          apiRoutes['buildings.delete'].replace('/:id', `/${this.value}`)
        )
        .then(() => {
          this.$emit('deleted')
          this.close()
        })
        .catch(() => {
          alert('Oops. Something went wrong. Please try again later.')
        })
    },
  },
}
</script>
