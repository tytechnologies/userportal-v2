<template>
  <div class="p-4">
    <div class="grid w-full grid-cols-2 gap-4 mb-4">
      <div class="mb-2">
        <Input
          id="unit_number"
          :placeholder="unitNumberLabel"
          type="text"
          v-model="form.unit_number"
          required
          :error="errors.unit_number"
          tooltip="This is for internal purposes only, will not appear in the site. (e.g 24E, Unit 3102)"
        >
          {{ unitNumberLabel }}
        </Input>
      </div>
      <div class="mb-2">
        <VSelect
          v-model="form.condition_id"
          :clearable="false"
          placeholder="Select condition"
          required
          :error="errors.condition_id"
          :options="conditions"
          label="name"
          :reduce="(item) => item.id"
        >
          Condition
        </VSelect>
      </div>

      <!-- For Rent -->
      <template v-if="isForRent">
        <!-- Rental Price -->
        <div class="mb-2">
          <Input
            id="rent_price"
            placeholder="e.g., 47000"
            type="number"
            min="0"
            v-model="form.rent_price"
            required
            :error="errors.rent_price"
          >
            {{ `Rental Price ${isCommercial ? '(pps)' : ''}`.trim() }}
          </Input>
        </div>

        <!-- Original Rental Price -->
        <div class="mb-2">
          <Input
            id="original_rent_price"
            placeholder="e.g., 47000"
            type="number"
            v-model="form.original_rent_price"
            :error="errors.original_rent_price"
          >
            {{ `Original Rental Price ${isCommercial ? '(pps)' : ''}`.trim() }}
          </Input>
        </div>
      </template>

      <!-- For Sale -->
      <template v-if="isForSale">
        <!-- Sale Price -->
        <div class="mb-2">
          <Input
            id="sale_price"
            placeholder="e.g., 47000"
            type="number"
            min="0"
            v-model="form.sale_price"
            required
            :error="errors.sale_price"
            >{{ `Sale Price ${isCommercial ? '(pps)' : ''}`.trim() }}</Input
          >
        </div>

        <!-- Original Sale Price -->
        <div class="mb-2">
          <Input
            id="original_sale_price"
            placeholder="e.g., 47000"
            type="number"
            min="0"
            v-model="form.original_sale_price"
            :error="errors.original_sale_price"
            >{{
              `Original Sale Price
                    ${isCommercial ? '(pps)' : ''}`.trim()
            }}</Input
          >
        </div>
      </template>

      <!-- Floor Area -->
      <div class="mb-2">
        <Input
          id="floor_area"
          placeholder="e.g., 200"
          type="number"
          v-model="form.floor_area"
          required
          :error="errors.floor_area"
          >Floor Area</Input
        >
      </div>

      <!-- Lot Area -->
      <div class="mb-2">
        <Input
          id="lot_area"
          placeholder="e.g., 200"
          type="number"
          v-model="form.lot_area"
          :error="errors.lot_area"
          >Lot Area</Input
        >
      </div>

      <!-- Status -->
      <div class="mb-2">
        <VSelect
          v-model="form.status_id"
          :clearable="false"
          placeholder="Select status"
          required
          :error="errors.status_id"
          :options="statuses"
          label="name"
          :reduce="(item) => item.id"
          >Status
        </VSelect>
      </div>

      <!-- Availability -->
      <div class="mb-2">
        <Input
          id="availability"
          placeholder="Availability"
          type="date"
          v-model="form.availability"
          required
          :error="errors.availability"
          >Availability</Input
        >
      </div>

      <template v-if="isResidential">
        <!-- Bedrooms -->
        <div class="mb-2">
          <VSelect
            v-model="form.bedrooms"
            :clearable="false"
            required
            :error="errors.bedrooms"
            :options="bedroomOptions"
            label="text"
            :reduce="(item) => item.value"
            >Bedrooms</VSelect
          >
        </div>
      </template>

      <!-- Car Space -->
      <div class="mb-2">
        <VSelect
          v-model="form.car_space"
          :clearable="false"
          required
          :error="errors.car_space"
          :options="carSpaceOptions"
          label="text"
          :reduce="(item) => item.value"
          >Car Space</VSelect
        >
      </div>
    </div>

    <div class="flex mt-auto">
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
import VSelect from '~/components/NewVSelect.vue'
import listingService from '@/services/listing.services'
import {
  jsonToFormData,
  showSwal,
  showLoading,
  dismissLoading,
  showToast,
} from '~/helpers/helpers'
import { apiRoutes } from '~/contants'

export default {
  mixins: [Auth, listingService],
  props: {
    listing: Object,
    constants: Object,
    statuses: Array,
  },
  data() {
    return {
      isServicedOffice: false,
      conditions: [],
      bedroomOptions: this.constants.bedrooms,
      carSpaceOptions: this.constants.car_space,
      isForRent: true,
      isForSale: true,
      isCommercial: false,
      isResidential: true,
      form: {
        division_id: this.listing.division_id,
        unit_number: this.listing.unit_number,
        condition_id: this.listing.condition_id,
        rent_price: this.listing.rent_price,
        original_rent_price: this.listing.original_rent_price,
        sale_price: this.listing.sale_price,
        original_sale_price: this.listing.original_sale_price,
        floor_area: this.listing.floor_area,
        lot_area: this.listing.lot_area,
        status_id: this.listing.status_id,
        availability: this.listing.formatted_availability,
        bedrooms: this.listing.bedrooms,
        car_space: this.listing.car_space,
      },
      errors: {},
    }
  },
  components: {
    Close,
    HelperText,
    Input,
    VSelect,
  },

  methods: {
    async save() {
      showLoading()
      try {
        const response = await this._quickUpdate(this.listing.id, this.form)
        this.submitCallback(response.data[0])
        showToast({ title: 'Listing updated successfully.', icon: 'success' })
      } catch (error) {
        showSwal({
          title: 'Quick Update',
          html: 'Oops. Something went wrong. Please try again later.',
          icon: 'error',
        })
      }
      dismissLoading()
    },

    fetchDivisionData() {
      this.$axios
        .$get(
          apiRoutes['divisions.show'].replace(
            '/:id',
            `/${this.form.division_id}`
          )
        )
        .then((data) => {
          this.conditions = data['conditions']
        })
    },

    submitCallback(data) {
      this.$emit('submitCallback', data)
    },
  },

  computed: {
    unitNumberLabel() {
      return this.isServicedOffice ? 'Suite number' : 'Unit number'
    },
  },

  mounted() {
    this.fetchDivisionData()
  },
}
</script>
