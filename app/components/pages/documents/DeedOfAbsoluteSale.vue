<template>
  <section class="flex flex-col h-full">
    <h3 class="mb-4 text-2xl font-black">Deed of Absolute Sale</h3>

    <ul
      class="hidden w-full leading-10 rounded-lg sm:flex md:flex lg:flex bg-muted/30 mb-9"
    >
      <li
        :class="
          ' flex-1 text-center font-bold rounded-lg ' +
          (step === 1 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Contract Data
      </li>
      <li
        :class="
          ' flex-1 text-center font-bold rounded-lg ' +
          (step === 2 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Seller Information
      </li>
      <li
        :class="
          'cursor-pointer hover:bg-primary/10 flex-1 text-center font-bold rounded-lg ' +
          (step === 3 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Buyer Information
      </li>
    </ul>

    <!-- Step 1: Property -->
    <div v-show="step === 1">
      <div class="grid w-full grid-cols-2 gap-4 mb-4">
        <!-- Property -->
        <div class="mb-2 col-span-2">
          <VSelect
            id="property_id"
            :model-value="form.propertyDetails.property_id"
            @option:selected="onPropertySelect"
            placeholder="Select property"
            :error="errors.property_id"
            :options="availableProperties"
            >Property</VSelect
          >
        </div>

        <!-- Property Name -->
        <div class="mb-2">
          <Input
            id="property_name"
            type="text"
            :model-value="form.propertyDetails.property_name"
            @change="(value) => (form.propertyDetails.property_name = value)"
            required
            :error="errors.property_name"
            >Property Name</Input
          >
        </div>

        <!-- Property Price -->
        <div class="mb-2">
          <Input
            id="property_price"
            type="number"
            :model-value="form.propertyDetails.property_price"
            @change="(value) => (form.propertyDetails.property_price = value)"
            required
            :error="errors.property_price"
            >Property Price</Input
          >
        </div>

        <!-- Property Address -->
        <div class="mb-2 col-span-2">
          <Input
            id="property_address"
            type="text"
            :model-value="form.propertyDetails.property_address"
            @change="(value) => (form.propertyDetails.property_address = value)"
            :error="errors.property_address"
            >Property Address</Input
          >
        </div>

        <!-- Property Area (sqm) -->
        <div class="mb-2">
          <Input
            id="property_area"
            type="text"
            :model-value="form.propertyDetails.property_area"
            @change="(value) => (form.propertyDetails.property_area = value)"
            :error="errors.property_area"
            >Property Area (sqm)</Input
          >
        </div>

        <!-- Title Number -->
        <div class="mb-2">
          <Input
            id="property_title_number"
            type="text"
            :model-value="form.propertyDetails.property_title_number"
            @change="(value) => (form.propertyDetails.property_title_number = value)"
            :error="errors.property_title_number"
            >Title Number</Input
          >
        </div>

        <!-- Contract Date & City -->
        <div class="mb-2 col-span-2 grid grid-cols-2 gap-4">
          <Input
            id="contract_date"
            type="date"
            :model-value="contractDateValue"
            @change="onContractDateChange"
            :error="errors.contract_date"
            >Contract Date</Input
          >
          <Input
            id="contract_city"
            type="text"
            :model-value="form.contractData.contractCity"
            @change="(value) => (form.contractData.contractCity = value)"
            :error="errors.contract_city"
            >Contract City</Input
          >
        </div>
      </div>
    </div>

    <!-- Step 2: Seller Information -->
    <div v-show="step === 2">
      <div class="mb-4">
        <ContactPicker
          label="Link seller to existing contact (optional)"
          :selected="form.sellerData.selectedContact"
          @select="onSellerContactSelect"
          @clear="onSellerContactClear"
        />
      </div>

      <div class="grid w-full grid-cols-2 gap-4 mb-4">
        <!-- Seller Name -->
        <div class="mb-2">
          <Input
            id="lessor_name"
            type="text"
            :model-value="form.sellerData.sellerName"
            @change="(value) => (form.sellerData.sellerName = value)"
            required
            :error="errors.seller_name"
            >Seller Name</Input
          >
        </div>

        <!-- Seller Gender -->
        <div class="mb-2">
          <Input
            id="seller_gender"
            type="text"
            :model-value="form.sellerData.sellerGender"
            @change="(value) => (form.sellerData.sellerGender = value)"
            required
            :error="errors.seller_gender"
            >Seller Gender</Input
          >
        </div>

        <!-- Seller Nationality -->
        <div class="mb-2">
          <Input
            id="seller_nationality"
            type="text"
            :model-value="form.sellerData.sellerNationality"
            @change="(value) => (form.sellerData.sellerNationality = value)"
            required
            :error="errors.seller_nationality"
            >Seller Nationality</Input
          >
        </div>

        <!-- Seller Civil Status -->
        <div class="mb-2">
          <Input
            id="seller_civil_status"
            type="text"
            :model-value="form.sellerData.sellerCivilStatus"
            @change="(value) => (form.sellerData.sellerCivilStatus = value)"
            required
            :error="errors.seller_civil_status"
            >Seller Civil Status</Input
          >
        </div>

        <!-- Seller Spouse -->
        <div class="mb-2">
          <Input
            id="seller_spouse"
            type="text"
            :model-value="form.sellerData.sellerSpouse"
            @change="(value) => (form.sellerData.sellerSpouse = value)"
            :error="errors.seller_spouse"
            >Seller Spouse</Input
          >
        </div>

        <!-- Seller Address -->
        <div class="mb-2">
          <Input
            id="seller_address"
            type="text"
            :model-value="form.sellerData.sellerAddress"
            @change="(value) => (form.sellerData.sellerAddress = value)"
            required
            :error="errors.seller_address"
            >Seller Address</Input
          >
        </div>
      </div>
    </div>

    <!-- Step 3: Buyer Information -->
    <div v-show="step === 3">
      <div class="mb-4">
        <ContactPicker
          label="Link buyer to existing contact (optional)"
          :selected="form.buyerData.selectedContact"
          @select="onBuyerContactSelect"
          @clear="onBuyerContactClear"
        />
      </div>

      <div class="grid w-full grid-cols-2 gap-4 mb-4">
        <!-- Buyer Name -->
        <div class="mb-2">
          <Input
            id="buyer_name"
            type="text"
            :model-value="form.buyerData.buyerName"
            @change="(value) => (form.buyerData.buyerName = value)"
            required
            :error="errors.buyer_name"
            >Buyer Name</Input
          >
        </div>

        <!-- Buyer Gender -->
        <div class="mb-2">
          <Input
            id="buyer_gender"
            type="text"
            :model-value="form.buyerData.buyerGender"
            @change="(value) => (form.buyerData.buyerGender = value)"
            required
            :error="errors.buyer_gender"
            >Buyer Gender</Input
          >
        </div>

        <!-- Buyer Nationality -->
        <div class="mb-2">
          <Input
            id="buyer_nationality"
            type="text"
            :model-value="form.buyerData.buyerNationality"
            @change="(value) => (form.buyerData.buyerNationality = value)"
            required
            :error="errors.buyer_nationality"
            >Buyer Nationality</Input
          >
        </div>

        <!-- Buyer Civil Status -->
        <div class="mb-2">
          <Input
            id="buyer_civil_status"
            type="text"
            :model-value="form.buyerData.buyerCivilStatus"
            @change="(value) => (form.buyerData.buyerCivilStatus = value)"
            required
            :error="errors.buyer_civil_status"
            >Buyer Civil Status</Input
          >
        </div>

        <!-- Buyer Spouse -->
        <div class="mb-2">
          <Input
            id="buyer_spouse"
            type="text"
            :model-value="form.buyerData.buyerSpouse"
            @change="(value) => (form.buyerData.buyerSpouse = value)"
            :error="errors.buyer_spouse"
            >Buyer Spouse</Input
          >
        </div>

        <!-- Buyer Address -->
        <div class="mb-2">
          <Input
            id="buyer_address"
            type="text"
            :model-value="form.buyerData.buyerAddress"
            @change="(value) => (form.buyerData.buyerAddress = value)"
            required
            :error="errors.buyer_address"
            >Buyer Address</Input
          >
        </div>

        <!-- Buyer Company Name -->
        <div class="mb-2">
          <Input
            id="buyer_company_name"
            type="text"
            :model-value="form.buyerData.buyerCompanyName"
            @change="(value) => (form.buyerData.buyerCompanyName = value)"
            required
            :error="errors.buyer_company_name"
            >Company Name</Input
          >
        </div>

        <!-- Buyer Company Address -->
        <div class="mb-2">
          <Input
            id="buyer_company_address"
            type="text"
            :model-value="form.buyerData.buyerCompanyAddress"
            @change="(value) => (form.buyerData.buyerCompanyAddress = value)"
            required
            :error="errors.buyer_company_address"
            >Company Address</Input
          >
        </div>
      </div>
    </div>

    <div class="flex mt-auto">
      <button
        type="button"
        class="mr-auto rounded-lg w-39 h-9 bg-green bg-opacity-20 hover:bg-green-dark hover:bg-opacity-30"
        @click="previousStep"
        v-show="step > 1"
      >
        <span class="inline-block text-green font-bold mt-0.5">Previous</span>
      </button>
      <button
        type="button"
        class="ml-auto rounded-lg w-39 h-9 bg-green bg-opacity-20 hover:bg-green-dark hover:bg-opacity-30"
        @click="nextStep"
        v-show="step < 3"
      >
        <span class="inline-block text-green font-bold mt-0.5">Next</span>
      </button>
      <button
        type="button"
        class="ml-auto rounded-lg w-39 h-9 bg-green"
        @click="save"
        v-show="step === 3"
      >
        <span class="inline-block text-white font-bold mt-0.5">Generate</span>
      </button>
    </div>
  </section>
</template>

<script>
import HelperText from '~/components/HelperText'
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import ContactPicker from '~/components/contacts/ContactPicker.vue'
import { generateDeedOfAbsoluteSellCall } from '~/services/document.services'
import { showToast, showLoading, dismissLoading } from '~/helpers/helpers'

export default {
  props: {
    nationalities: {
      type: Array,
      default: [],
    },
    civilStatuses: {
      type: Array,
      default: [],
    },
  },
  components: { Input, HelperText, VSelect, ContactPicker },
  data() {
    return {
      availableProperties: [],
      rateUnits: [
        { id: 'days', text: 'Days' },
        { id: 'months', text: 'Months' },
        { id: 'years', text: 'Years' },
      ],
      genders: [
        { id: 'male', text: 'Male' },
        { id: 'female', text: 'Female' },
        { id: 'other', text: 'Other' },
      ],
      form: {
        sellerData: {
          // Cross-entity link to a contact — surfaces document on the
          // contact's unified timeline.
          contact_id: null,
          selectedContact: null,
          sellerName: '',
          sellerGender: '',
          sellerCivilStatus: '',
          sellerSpouse: '',
          sellerNationality: '',
          sellerAddress: '',
        },
        buyerData: {
          contact_id: null,
          selectedContact: null,
          buyerName: '',
          buyerGender: '',
          buyerCivilStatus: '',
          buyerSpouse: '',
          buyerNationality: '',
          buyerAddress: '',
        },
        contractData: {
          contractDay: '',
          contractMonth: '',
          contractYear: '',
          contractCity: 'Manila',
          contractPrice: '',
        },
        propertyDetails: {
          property_id: '',
          property_name: '',
          property_price: '',
          property_address: '',
          property_area: '',
          property_title_number: '',
        },
      },
      errors: {},
      step: 1,
    }
  },
  async mounted() {
    const { data: listingDetails, error: listingDetailsError } =
      await useSupabaseClient()
        // Reads from `listing_details` (canonical wide read source).
        .from('listing_details')
        .select('listing_id, title, property_name, street_address, floor_area, sale_price, rent_price')
        .order('updated_at', { ascending: false })

    if (listingDetailsError) {
      console.error('Error fetching listing details:', listingDetailsError)
      return
    }

    const list = listingDetails || []
    this.availableProperties = list.map((listing) => ({
      id: listing.listing_id,
      value: listing.listing_id,
      label: `ID ${listing.listing_id} - ${listing.title || 'Untitled'}`,
      text: listing.title,
      property_name: listing.property_name,
      street_address: listing.street_address,
      floor_area: listing.floor_area,
      sale_price: listing.sale_price,
      rent_price: listing.rent_price,
    }))

    // Default contract date to today
    const now = new Date()
    this.form.contractData.contractDay = String(now.getDate())
    this.form.contractData.contractMonth = String(now.getMonth() + 1)
    this.form.contractData.contractYear = String(now.getFullYear())
  },
  computed: {
    contractDateValue() {
      const { contractDay, contractMonth, contractYear } = this.form.contractData
      if (!contractDay || !contractMonth || !contractYear) return ''
      const m = String(contractMonth).padStart(2, '0')
      const d = String(contractDay).padStart(2, '0')
      return `${contractYear}-${m}-${d}`
    },
  },
  methods: {
    onSellerContactSelect(contact) {
      this.form.sellerData.contact_id = contact?.id ?? null
      this.form.sellerData.selectedContact = contact ?? null
      if (!contact) return
      this.form.sellerData.sellerName = contact.full_name || this.form.sellerData.sellerName
    },
    onSellerContactClear() {
      this.form.sellerData.contact_id = null
      this.form.sellerData.selectedContact = null
    },
    onBuyerContactSelect(contact) {
      this.form.buyerData.contact_id = contact?.id ?? null
      this.form.buyerData.selectedContact = contact ?? null
      if (!contact) return
      this.form.buyerData.buyerName = contact.full_name || this.form.buyerData.buyerName
    },
    onBuyerContactClear() {
      this.form.buyerData.contact_id = null
      this.form.buyerData.selectedContact = null
    },
    onContractDateChange(value) {
      if (value) {
        const [y, m, d] = value.split('-')
        this.form.contractData.contractYear = y || ''
        this.form.contractData.contractMonth = m ? String(parseInt(m, 10)) : ''
        this.form.contractData.contractDay = d ? String(parseInt(d, 10)) : ''
      }
    },
    onPropertySelect(property) {
      if (property) {
        this.form.propertyDetails.property_id = property.value || property.id
        this.form.propertyDetails.property_name = property.property_name || ''
        this.form.propertyDetails.property_price =
          property.sale_price ?? property.rent_price ?? ''
        this.form.propertyDetails.property_address = property.street_address || ''
        this.form.propertyDetails.property_area = property.floor_area ? String(property.floor_area) : ''
        this.form.contractData.contractPrice = this.form.propertyDetails.property_price
      }
    },
    nextStep() {
      this.step++
    },
    previousStep() {
      this.step--
    },
    save() {
      // Sync contract price from property price
      this.form.contractData.contractPrice = this.form.propertyDetails.property_price || this.form.contractData.contractPrice
      showLoading()
      generateDeedOfAbsoluteSellCall(this.form)
        .then((fileUrl) => {
          dismissLoading()
          showToast({
            title: 'Deed of Absolute Sale generated successfully. Check your Document Checklist',
            icon: 'success',
          })
          if (fileUrl) window.open(fileUrl, '_blank')
        })
        .catch((err) => {
          dismissLoading()
          showToast({
            title: err?.message || 'Failed to generate document',
            icon: 'error',
          })
        })
    },
  },
}
</script>
