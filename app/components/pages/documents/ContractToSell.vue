<template>
  <section class="flex flex-col h-full">
    <h3 class="mb-4 text-2xl font-black">Contract to Sell</h3>

    <ul
      class="hidden w-full leading-10 rounded-lg sm:flex md:flex lg:flex bg-muted/30 mb-9"
    >
      <li
        :class="
          ' flex-1 text-center font-bold rounded-lg ' +
          (step === 1 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Property
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

        <!-- Property Address -->
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

        <!-- Property Area & Title Number -->
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
      </div>
    </div>

    <!-- Step 2: Seller Information -->
    <div v-show="step === 2">
      <!-- Optional contact picker. Selecting an existing contact stamps
           sellerData.contact_id, which the generator threads into
           documents.metadata so the resulting audit row appears on
           that contact's unified timeline. Manual entry still works. -->
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
        <!-- Downpayment Amount -->
        <div class="mb-2">
          <Input
            id="downpayment_amount"
            type="number"
            :model-value="form.buyerData.downpaymentAmount"
            @change="(value) => (form.buyerData.downpaymentAmount = value)"
            required
            :error="errors.downpayment_amount"
            >Downpayment Amount</Input
          >
        </div>
        <!-- Payment Terms -->
        <div class="mb-2 col-span-2">
          <label>
            <input
              type="radio"
              id="monthly"
              value="monthly"
              v-model="form.paymentTerms"
            />
            Monthly
          </label>
          <label>
            <input
              type="radio"
              id="deadline"
              value="deadline"
              v-model="form.paymentTerms"
            />
            Deadline
          </label>

          <div v-if="form.paymentTerms === 'monthly'" class="mt-2 w-1/2">
            <Input
              id="num_post_date_cheques"
              type="number"
              :model-value="form.buyerData.numPostDateCheques"
              @change="(value) => (form.buyerData.numPostDateCheques = value)"
              required
              :error="errors.num_post_date_cheques"
              >No. of Post Date Cheques
            </Input>
          </div>

          <div v-if="form.paymentTerms === 'deadline'" class="mt-2 w-1/2">
            <Input
              id="payment_deadline"
              type="date"
              :model-value="form.buyerData.paymentDeadline"
              @change="(value) => (form.buyerData.paymentDeadline = value)"
              required
              :error="errors.payment_deadline"
              >Payment Deadline</Input
            >
          </div>
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
import { generateContractToSellCall } from '~/services/document.services'
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
        contractData: {
          contractDay: '',
          contractMonth: '',
          contractYear: '',
          contractPrice: '',
          uponSigningPrice: '',
          balanceLeftPrice: '',
          contractTerm: '',
          postDatedChecks: '',
        },
        sellerData: {
          // contact_id flows into documents.metadata so the resulting
          // document.uploaded audit row pivots onto this contact's
          // unified timeline. selectedContact is the picker's controlled
          // state.
          contact_id: null,
          selectedContact: null,
          sellerName: '',
          sellerSpouse: '',
          sellerNationality: '',
          sellerAddress: '',
        },
        buyerData: {
          contact_id: null,
          selectedContact: null,
          buyerName: '',
          buyerNationality: '',
          buyerAddress: '',
        },
        propertyDetails: {
          property_id: '',
          property_name: '',
          property_price: '',
          property_area: '',
          property_title_number: '',
          street_address: '',
          floor_area: '',
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

    const now = new Date()
    this.form.contractData.contractDay = String(now.getDate())
    this.form.contractData.contractMonth = String(now.getMonth() + 1)
    this.form.contractData.contractYear = String(now.getFullYear())
  },
  methods: {
    onSellerContactSelect(contact) {
      this.form.sellerData.contact_id = contact?.id ?? null
      this.form.sellerData.selectedContact = contact ?? null
      if (!contact) return
      this.form.sellerData.sellerName = contact.full_name || this.form.sellerData.sellerName
      this.form.sellerData.sellerAddress =
        contact.notes || this.form.sellerData.sellerAddress
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
      this.form.buyerData.buyerAddress =
        contact.notes || this.form.buyerData.buyerAddress
    },
    onBuyerContactClear() {
      this.form.buyerData.contact_id = null
      this.form.buyerData.selectedContact = null
    },
    onPropertySelect(property) {
      if (property) {
        this.form.propertyDetails.property_id = property.value || property.id
        this.form.propertyDetails.property_name = property.property_name || property.text || ''
        this.form.propertyDetails.property_price = property.sale_price ?? property.rent_price ?? ''
        this.form.propertyDetails.property_area = property.floor_area ? String(property.floor_area) : ''
        this.form.propertyDetails.street_address = property.street_address || ''
        this.form.propertyDetails.floor_area = property.floor_area || ''
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
      this.form.contractData.contractPrice =
        this.form.propertyDetails.property_price || this.form.contractData.contractPrice
      showLoading()
      generateContractToSellCall(this.form)
        .then((fileUrl) => {
          dismissLoading()
          showToast({
            title: 'Contract to Sell generated successfully. Check your Document Checklist',
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
