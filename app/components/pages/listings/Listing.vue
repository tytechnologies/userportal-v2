<template>
  <aside class="sticky top-0 flex flex-col h-screen px-4 py-6 bg-card w-120">
    <div class="flex">
      <h5 class="mt-1 font-bold">Listing Details</h5>
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
    <div
      v-if="images.length > 0"
      class="w-full h-56 overflow-hidden rounded-lg bg-muted/30 mb-7"
    >
      <img :src="images[0]" alt="Image" />
    </div>
    <div class="flex mb-2">
      <h5 class="flex-1 text-2xl font-bold">{{ data.name }}</h5>
      <div
        class="relative inline-block mr-2 text-left"
        v-on-clickaway="hideActions"
        v-if="
          userHasPermissionTo('properties.upsert') ||
          userHasPermissionTo('properties.delete')
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
            class="absolute right-0 z-10 w-32 mt-2 origin-top-right bg-card rounded-md shadow-lg focus:outline-none"
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
                  @click="preview"
                >
                  Preview
                </button>
              </li>
              <li
                class="pt-1.5 pb-0.5 hover:bg-muted"
                v-if="userHasPermissionTo('properties.upsert')"
              >
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="edit"
                >
                  Edit
                </button>
              </li>
              <!--              <li class="pt-1.5 pb-0.5 hover:bg-muted">-->
              <!--                <button type="button" class="w-full h-6 px-3 text-sm font-medium text-left" @click="hideActions">Clone</button>-->
              <!--              </li>-->
              <li
                class="pt-1.5 pb-0.5 hover:bg-muted"
                v-if="userHasPermissionTo('properties.upsert')"
              >
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="changeOnlineStatus"
                >
                  Mark as {{ isOnline ? 'Offline' : 'Online' }}
                </button>
              </li>
              <li
                class="pt-1.5 pb-0.5 hover:bg-muted"
                v-if="userHasPermissionTo('properties.delete')"
              >
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="confirmArchive"
                >
                  Archive
                </button>
              </li>
              <li
                class="pt-1.5 pb-0.5 hover:bg-muted"
                v-if="userHasPermissionTo('properties.delete')"
              >
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="confirmDelete"
                >
                  Delete
                </button>
              </li>
            </ul>
          </div>
        </transition>
      </div>
    </div>
    <div class="flex mb-10 text-sm font-medium text-gray-3">
      <span class="mr-6">ID {{ data.id }}</span>
      <span
        class="w-4 h-4 mr-2 rounded"
        :class="isOnline ? 'bg-green' : 'bg-muted'"
      ></span>
      <span>{{ isOnline ? 'Online' : 'Offline' }}</span>
    </div>
    <div
      class="flex-1 mb-6 overflow-y-auto scrollbar-thin scrollbar-thumb-black-10 scrollbar-thumb-rounded-full"
    >
      <table class="w-full table-fixed">
        <tbody class="divide-y-8 divide-white">
          <tr v-for="(row, index) in rows" :key="index" class="w-6">
            <th class="text-left">{{ row[0] }}</th>
            <td>{{ row[1] }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <Alert
      v-model="showArchiveConfirmation"
      icon="success"
      @ok="archive"
      confirm-button-text="Archive"
    >
      <div class="text-center">
        <h3 class="text-lg font-medium leading-6 text-foreground">
          Do you really want to archive
        </h3>
        <p class="text-lg font-medium leading-6 text-muted-foreground/70">
          {{ data.name }}
        </p>
      </div>
    </Alert>
    <Alert
      v-model="showDeleteConfirmation"
      icon="success"
      @ok="destroy"
      confirm-button-text="Delete"
    >
      <div class="text-center">
        <h3 class="text-lg font-medium leading-6 text-foreground">
          Do you really want to delete
        </h3>
        <p class="text-lg font-medium leading-6 text-muted-foreground/70">
          {{ data.name }}
        </p>
      </div>
    </Alert>
  </aside>
</template>

<script>
import { format } from 'date-fns'
import Auth from '~/mixins/auth'
import Alert from '~/components/CustomAlert.vue'
import Close from 'vue-material-design-icons/Close.vue'
import DotsVertical from 'vue-material-design-icons/DotsVertical.vue'
import { apiRoutes } from '~/contants'//'~/contants'
import { createPropertySlug } from '~/helpers/properties'

export default {
  mixins: [Auth],
  props: ['value'],
  components: { Alert, Close, DotsVertical },
  data() {
    return {
      data: {},
      showActions: false,
      showArchiveConfirmation: false,
      showDeleteConfirmation: false,
    }
  },
  computed: {
    isOnline() {
      return !!this.data['is_online']
    },
    images() {
      return this.data['images'] || []
    },
    rows() {
      if (!this.value || Object.keys(this.data).length === 0) {
        return []
      }

      const rows = [
        ['Rent/Sale', this.data['category']],
        ['Price', this.data['formatted_price']],
        ['Price/Sqm.', this.data['formatted_price_per_sqm']],
        ['Condition', this.data['condition.name']],
        ['Status', this.data['status.name']],
        ['Parking', this.data['parking']],
        ['Bedrooms', this.data['bedrooms']],
        ['Lot Area', this.data['parking']],
        [
          'Parking',
          this.data['lot_area'] !== null ? this.data['lot_area'] : '-',
        ],
        ['Has Balcony', this.data['has_balcony'] ? 'Yes' : 'No'],
        ['Are Pets Allowed', this.data['are_pets_allowed'] ? 'Yes' : 'No'],
        ['City', this.data['city.name']],
        [
          'Availability',
          format(new Date(this.data['availability']), 'MM/dd/yyyy'),
        ],
        ['Designation', this.data['user.designation']],
        ['Contact', this.data['user.name']],
      ]

      if (!!this.data['uploader.name']) {
        rows.push(['Uploaded By', this.data['uploader.name']])
      }

      rows.push(['Remarks', this.data['remarks']])

      return rows
    },
  },
  watch: {
    value(value) {
      if (!!value) {
        this.load(value)
      } else {
        this.data = {}
      }
    },
  },
  methods: {
    load(id) {
      $fetch(apiRoutes['listings.show'].replace('/:id', `/${id}`)).then(
        (data) => {
          this.data = data
        }
      )
    },
    close() {
      this.$emit('close')
    },
    hideActions() {
      this.showActions = false
    },
    preview() {
      this.$router.push(`property/${createPropertySlug(this.data)}`)
    },
    edit() {
      this.$emit('edit', this.value)
      this.hideActions()
    },
    changeOnlineStatus() {
      this.$axios
        .$post(
          apiRoutes['listings.mark-as-online'].replace(
            '/:id',
            `/${this.value}`
          ),
          {
            _method: 'PATCH',
            is_online: !this.isOnline,
          }
        )
        .then(() => {
          this.load(this.value)
          this.$emit('updated')
        })
        .catch(() => {
          alert('Oops. Something went wrong. Please try again later.')
        })
    },
    confirmArchive() {
      this.showArchiveConfirmation = true
      this.hideActions()
    },
    archive() {
      this.showArchiveConfirmation = false
      this.$axios
        .$delete(
          apiRoutes['listings.archive'].replace('/:id', `/${this.value}`)
        )
        .then(() => {
          this.$emit('deleted')
          this.close()
        })
        .catch(() => {
          alert('Oops. Something went wrong. Please try again later.')
        })
    },
    confirmDelete() {
      this.showDeleteConfirmation = true
      this.hideActions()
    },
    destroy() {
      this.showDeleteConfirmation = false
      this.$axios
        .$delete(apiRoutes['listings.delete'].replace('/:id', `/${this.value}`))
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
