<template>
  <div class="p-4">
    <h4 class="mb-4">Search contact to transfer to:</h4>
    <!-- Search -->
    <div
      class="hi-search flex sm:flex-row md:flex-row lg:flex-row bg-card px-3 py-2 mb-2 border border-grey focus-within:border-blue rounded-lg"
    >
      <div class="flex w-full items-center">
        <font-awesome-icon icon="magnifying-glass" class="mr-2 text-muted-foreground" />
        <div class="w-full relative flex flex-1 justify-between">
          <input
            type="text"
            placeholder="Search..."
            v-model="contactsUrlParams.search"
            v-on:input="search"
            class="flex-1 w-full focus:outline-none focus:shadow-none border-0 focus:ring-0 font-bold placeholder-gray-3"
          />

          <span
            class="cursor-pointer mr-2 w-8 h-8 text-center pt-1.5 bg-muted inline-block rounded-lg"
            title="Reset Search"
            @click="resetSearch"
          >
            <font-awesome-icon icon="recycle" />
          </span>
        </div>
      </div>
    </div>
    <ContactSuggestionBox
      :suggestions="suggestions.data"
      v-if="suggestionBoxStatus"
      v-on:input="suggestionsInput"
      v-on-clickaway="close"
    />

    <div class="m-4 font-bold">
      Transfer listings of
      {{ contactFrom.name }} ({{ contactFrom.email }}) to
      <span v-if="contactTo != null"
        >{{ contactTo.name }} ({{ contactTo.email }})
      </span>
      <span v-else>...</span>
    </div>

    <div class="mt-4 mb-4 pt-4 flex items-center">
      <button
        type="button"
        class="m-auto w-39 h-9 bg-green rounded-lg"
        @click="submit"
        :disabled="!hasTransferToSelected"
      >
        <span class="inline-block text-white font-bold mt-0.5"
          >Transfer Listings</span
        >
      </button>
    </div>
  </div>
</template>

<script>
import debounce from 'lodash/debounce'
import * as contactService from '@/services/contact.services'
import ContactSuggestionBox from '@/components/pages/contacts/ContactSuggestionBox.vue'
import Swal from 'sweetalert2'
import { dismissLoading, showLoading, showToast } from '@/helpers/helpers'

export default {
  props: {
    contactFrom: {
      default: null,
    },
  },

  mixins: [contactService],

  components: {
    ContactSuggestionBox,
  },

  data() {
    return {
      contactTo: null,
      contactsUrlParams: {},
      suggestions: {
        data: [],
      },
      suggestionBoxStatus: false,
    }
  },

  computed: {
    hasTransferToSelected() {
      return this.contactTo !== null
    },
  },

  methods: {
    buildQueryParams() {
      let params = []
      for (const [key, value] of Object.entries(this.contactsUrlParams)) {
        if (value !== null) {
          params.push(`${key}=${value}`)
        }
      }
      return '?' + params.join('&')
    },

    close() {
      this.suggestionBoxStatus = false
    },

    async fetch() {
      //await showLoading()
      try {
        this.suggestions = await this._getContacts(this.buildQueryParams())
        this.suggestionBoxStatus = true
      } catch (error) {
        // console.error(error);
      }
      //dismissLoading()
    },

    search: debounce(function (e) {
      this.contactsUrlParams['page'] = null
      this.fetch()
    }, 300),

    resetSearch() {
      this.contactTo = null
      this.contactsUrlParams = {}
    },

    suggestionsInput(contact) {
      this.contactTo = contact
      this.suggestionBoxStatus = false
    },

    submit() {
      Swal.fire({
        title: 'Transfer Listing',
        html: `You are about to transfer a contact's listings. Please note that you cannot undo this.`,
        confirmButtonColor: '#E73F31',
        confirmButtonText: 'Proceed?',
        showCancelButton: true,
      }).then((result) => {
        if (result.isConfirmed) {
          this.transfer()
        }
      })
    },

    async transfer() {
      await showLoading()

      const res = await this._transferContactListings(
        this.contactFrom.id,
        this.contactTo.id
      )

      if (res.success) {
        showToast({
          title: 'Contact listings transfered successfully!',
          icon: 'info',
        })
      } else {
        const message = res.message ?? 'Something went wrong. Please try again.'
        showToast({ title: message, icon: 'warning' })
      }

      dismissLoading()

      this.$emit('close')
    },
  },
}
</script>
