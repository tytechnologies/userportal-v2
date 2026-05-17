<template>
  <div class="p-4">
    <div class="flex mb-2" v-for="(clone, index) in form.clones" :key="index">
      <div class="flex-auto">
        <Input
          id="unit_number"
          :placeholder="isServicedOffice ? 'Suite number' : 'Unit number'"
          type="text"
          v-model="clone.unit_number"
          required
          :error="clone.error"
          tooltip="This is for internal purposes only, will not appear in the site. (e.g 24E, Unit 3102)"
        >
          {{ isServicedOffice ? 'Suite number' : 'Unit number' }}
        </Input>
      </div>

      <button
        v-if="index == 0"
        class="flex-none mt-6 ml-4 mr-4 text-xl"
        title="Add More Clone"
        @click="addClone"
      >
        <font-awesome-icon icon="plus" />
      </button>
      <button
        v-else
        class="flex-none mt-6 ml-4 mr-4"
        title="Remove clone"
        @click="removeClone(index)"
      >
        <font-awesome-icon icon="eraser" />
      </button>
    </div>

    <div class="flex mt-12">
      <button
        type="button"
        class="ml-auto rounded-lg w-39 h-9 bg-green"
        @click="save"
      >
        <span class="inline-block text-white font-bold mt-0.5">Save</span>
      </button>
    </div>
  </div>
</template>

<script>
import Auth from '~/mixins/auth'
import Close from 'vue-material-design-icons/Close.vue'
import HelperText from '~/components/HelperText'
import Input from '~/components/Input.vue'
import listingService from '@/services/listing.services'
import {
  jsonToFormData,
  showSwal,
  showLoading,
  dismissLoading,
  showToast,
} from '~/helpers/helpers'
import { apiRoutes } from '~/contants'

import { library } from '@fortawesome/fontawesome-svg-core'
import { faPlus, faEraser } from '@fortawesome/free-solid-svg-icons'

library.add(faPlus, faEraser)

export default {
  mixins: [Auth, listingService],
  props: {
    listing: Object,
  },
  data() {
    return {
      form: {
        type_id: this.listing.type_id,
        clones: [],
      },
      errors: {
        unit_numbers: [],
      },
    }
  },
  components: {
    Close,
    HelperText,
    Input,
  },
  computed: {
    isServicedOffice() {
      return this.listing.is_serviced_office
    },
  },
  methods: {
    addClone() {
      this.resetUnitNumberRequiredCheck()
      this.form.clones.push(this.cloneData())
    },

    removeClone(index) {
      this.form.clones = this.form.clones.filter((v, i) => i !== index)
    },

    cloneData() {
      return {
        unit_number: null, //this.listing.unit_number,
        error: null,
      }
    },

    save() {
      if (!this.unitNumberRequiredCheck()) return

      const url = apiRoutes['listings.duplicate'].replace(
        '/:id',
        `/${this.listing.id}`
      )

      showLoading()

      this.$axios
        .$post(url, this.form)
        .then((res) => {
          dismissLoading()
          showToast({ title: 'Listing cloned successfully!' })
          this.$emit('submitCallback')
        })
        .catch(this.processErrors)
    },

    unitNumberRequiredCheck() {
      let hasNoError = true
      let error
      this.form.clones.map((item) => {
        error = null
        if (!item.unit_number) {
          error = 'The field must not be empty!'
          hasNoError = false
        }

        item.error = error
      })

      return hasNoError
    },

    resetUnitNumberRequiredCheck() {
      this.form.clones.map((item) => {
        item.error = null
      })
    },

    processErrors(error) {
      const response = error.response

      dismissLoading()

      if (response.status === 422) {
        const errors = response.data.errors
        for (let key in errors) {
          if (errors.hasOwnProperty(key)) {
            errors[key] = errors[key][0]
          }
        }
        this.errors = errors
      } else {
        showSwal({
          title: 'Clone Listing',
          html: 'Oops. Something went wrong. Please try again later.',
          icon: 'error',
        })
      }
    },

    submitCallback() {},
  },
  mounted() {
    this.addClone()
  },
}
</script>
