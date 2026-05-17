<template>
  <aside class="sticky top-0 flex flex-col h-screen px-4 py-6 bg-card w-120">
    <div class="flex">
      <h5 class="mt-1 font-bold">Contact Details</h5>
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
    <div class="relative w-full mb-20 h-25 bg-muted/50">
      <div
        class="absolute inset-x-0 mx-auto overflow-hidden rounded-full w-26 h-26 top-1/2"
      >
        <img
          v-if="data.avatar"
          class="img-fit"
          :src="data.avatar"
          alt="Image"
        />
        <span v-else class="text-foreground">
          <Account :size="104" />
        </span>
      </div>
    </div>
    <div class="relative text-center">
      <h3 class="text-2xl font-bold text-foreground">{{ data.name }}</h3>
      <div
        class="absolute right-0 inline-block mr-2 text-left"
        v-on-clickaway="hideActions"
        v-if="
          userHasPermissionTo('contacts.upsert') ||
          userHasPermissionTo('contacts.delete')
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
              <li
                class="pt-1.5 pb-0.5 hover:bg-muted"
                v-if="userHasPermissionTo('contacts.upsert')"
              >
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="edit"
                >
                  Edit
                </button>
              </li>
              <li
                class="pt-1.5 pb-0.5 hover:bg-muted"
                v-if="userHasPermissionTo('contacts.merge')"
              >
                <button
                  type="button"
                  class="w-full h-6 px-3 text-sm font-medium text-left"
                  @click="mergeSelection"
                >
                  Merge
                </button>
              </li>
              <li
                class="pt-1.5 pb-0.5 hover:bg-muted"
                v-if="userHasPermissionTo('contacts.delete')"
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
    <div class="text-center mb-9">
      <span class="inline-block text-sm font-medium text-gray-3"
        >ID {{ data.id }}</span
      >
      <!--      <span class="relative inline-block w-4 h-4 rounded-md top-1" :class="true ? 'bg-green' : 'bg-muted'"></span>-->
    </div>
    <div
      class="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-black-10 scrollbar-thumb-rounded-full mb-9"
    >
      <div v-for="(row, index) in rows" :key="index" class="mb-6">
        <p class="h-12 px-4 py-3 text-lg font-bold rounded-lg bg-muted/50">
          {{ row[0] }}
        </p>
        <p class="h-12 px-4 py-3 font-medium rounded-lg text-foreground">
          {{ row[1] }}
        </p>
      </div>
    </div>
    <Alert
      v-model="showDeleteConfirmation"
      icon="success"
      @ok="destroy"
      confirm-button-text="Delete"
    >
      <div class="text-center">
        <h3 class="text-lg font-medium leading-6 text-foreground">
          Do you really want to delete contact
        </h3>
        <p class="text-lg font-medium leading-6 text-muted-foreground/70">
          {{ data.name }}
        </p>
      </div>
    </Alert>
    <Alert
      v-model="showMergeSelection"
      icon="success"
      @ok="merge"
      confirm-button-text="Merge"
    >
      <div class="mb-2">
        <VSelect
          v-if="userHasPermissionTo('contacts.merge')"
          id="merge_id"
          v-model="merge_id"
          @search="onFetchOwners"
          :clearable="false"
          :filterable="false"
          placeholder="Select owner"
          required
          :error="errors.merge_id"
          :options="ownerOptions"
          label="name"
          :reduce="(item) => item.id"
          >Owner</VSelect
        >
        <Input
          v-else
          id="owner"
          type="text"
          :value="$auth.user.name"
          required
          readonly
          >Owner</Input
        >
      </div>
    </Alert>
  </aside>
</template>

<script>
import Auth from '~/mixins/auth'
import Account from 'vue-material-design-icons/Account.vue'
import Alert from '~/components/CustomAlert.vue'
import Close from 'vue-material-design-icons/Close.vue'
import Owners from '~/mixins/domains/owners'
import DotsVertical from 'vue-material-design-icons/DotsVertical.vue'
import VSelect from '~/components/NewVSelect.vue'
import { apiRoutes } from '~/contants'

export default {
  mixins: [Auth, Owners],
  props: ['value'],
  components: { Account, Alert, Close, DotsVertical, VSelect },
  data() {
    return {
      data: {},
      merge_id: 0,
      errors: {},
      showActions: false,
      showDeleteConfirmation: false,
      showMergeSelection: false,
    }
  },
  computed: {
    rows() {
      if (!this.value || Object.keys(this.data).length === 0) {
        return []
      }

      return [
        ['Designation', this.data['designation']],
        ['Email', this.data['email']],
        ['Landline', this.data['phone']],
        ['Mobile', this.data['mobile']],
        ['Facebook Link', this.data['facebook_link']],
        ['Instagram Link', this.data['instagram_link']],
        ['Notes', this.data['notes']],
      ]
    },
  },
  watch: {
    value(value) {
      if (!!value) {
        this.$axios
          .$get(apiRoutes['contacts.show'].replace('/:id', `/${value}`))
          .then((data) => {
            this.data = data
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
    mergeSelection() {
      this.$axios
        .$get(apiRoutes['contacts.getAll'].replace('/:id', `/${this.value}`))
        .then((data) => {
          this.filteredContacts = data
        })
      this.showMergeSelection = true
    },
    confirmDelete() {
      this.showDeleteConfirmation = true
      this.hideActions()
    },
    merge() {
      this.$axios.$patch(
        apiRoutes['contacts.merge'].replace('/:id', `/${this.value}`),
        {
          merge_id: this.merge_id,
        }
      )
    },
    destroy() {
      this.showDeleteConfirmation = false
      this.$axios
        .$delete(apiRoutes['contacts.delete'].replace('/:id', `/${this.value}`))
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
