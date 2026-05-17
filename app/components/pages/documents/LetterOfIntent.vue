<template>
  <section class="flex flex-col h-full">
    <h3 class="mb-4 text-2xl font-black">Letter of Intent</h3>

    <ul
      class="hidden w-full leading-10 rounded-lg sm:flex md:flex lg:flex bg-muted/30 mb-9"
    >
      <li
        :class="
          'cursor-pointer hover:bg-primary/10 flex-1 text-center font-bold rounded-lg ' +
          (step === 1 ? 'bg-primary/10 text-primary' : '')
        "
        @click="changeStep(1)"
      >
        Property
      </li>
      <li
        :class="
          'cursor-pointer hover:bg-primary/10 flex-1 text-center font-bold rounded-lg ' +
          (step === 2 ? 'bg-primary/10 text-primary' : '')
        "
        @click="changeStep(2)"
      >
        Contact Person
      </li>
      <li
        :class="
          'cursor-pointer hover:bg-primary/10 flex-1 text-center font-bold rounded-lg ' +
          (step === 3 ? 'bg-primary/10 text-primary' : '')
        "
        @click="changeStep(3)"
      >
        Client Information
      </li>

      <li
        :class="
          'cursor-pointer hover:bg-primary/10 flex-1 text-center font-bold rounded-lg ' +
          (step === 4 ? 'bg-primary/10 text-primary' : '')
        "
        @click="changeStep(4)"
      >
        Letter Details
      </li>
    </ul>

    <!-- Step 1: Property -->
    <div v-show="step === 1">
      <div
        class="w-full gap-4 mb-4 sm:grid sm:grid-cols-2 md:grid md:grid-cols-2 lg:grid lg:grid-cols-2"
      >
        <!-- Property Division -->
        <div class="mb-2">
          <VSelect
            :model-value="form.contractData.propertyDivision"
            :options="[
              { label: 'Residential', value: 'residential' },
              { label: 'Commercial', value: 'commercial' },
            ]"
            @onChange="
              (value) => {
                handleDivisionChange(value)
                form.contractData.propertyTitle = null
              }
            "
            :searchable="false"
          >
            Property Division
          </VSelect>
        </div>

        <!-- Property Category -->
        <div class="mb-2">
          <VSelect
            :model-value="form.contractData.propertyCategory"
            :options="[
              { label: 'Rent', value: 'rent' },
              { label: 'Sale', value: 'sale' },
            ]"
            @onChange="
              (value) => {
                handleCategoryChange(value)
                form.contractData.propertyTitle = null
              }
            "
          >
            Property Category
          </VSelect>
        </div>

        <!-- Property Title -->
        <div class="mb-2">
          <VSelect
            :model-value="form.contractData.propertyTitle"
            :options="propertyOptions"
            @onChange="
              (value) => {
                form.contractData.propertyTitle = value
                form.contractData.propertyAddress = propertyOptions.find(
                  (option) => option.value === value
                ).streetAddress
                form.contractData.propertyFloorArea = propertyOptions.find(
                  (option) => option.value === value
                ).propertyFloorArea
                form.contractData.propertyCondition = propertyOptions.find(
                  (option) => option.value === value
                ).propertyCondition
              }
            "
          >
            Property Title
          </VSelect>
        </div>

        <!-- Property Price -->
        <div class="mb-2">
          <Input
            id="property_price"
            type="number"
            min="0"
            :model-value="form.contractData.propertyPrice"
            @change="(value) => (form.contractData.propertyPrice = value)"
            :error="errors.property_price"
          >
            Property Price
          </Input>
        </div>

        <!-- Lease Starting Date -->
        <div class="mb-2">
          <Input
            id="lease_start_date"
            type="date"
            :min="new Date().toISOString().split('T')[0]"
            :model-value="form.contractData.leaseStartDate"
            @change="(value) => (form.contractData.leaseStartDate = value)"
            required
            :error="errors.lease_start_date"
          >
            Lease Starting Date
          </Input>
        </div>

        <div class="col-span-2 flex flex-col w-full items-center">
          <!-- Minimum Lease Term -->
          <div class="mb-2 flex gap-2 w-full">
            <div class="w-72">
              <Input
                id="min_lease_term_value"
                type="number"
                min="1"
                max="12"
                :model-value="form.contractData.minLeaseTermValue"
                @change="
                  (value) => (form.contractData.minLeaseTermValue = value)
                "
                class="w-full"
              >
                Minimum Lease Term
              </Input>
            </div>
            <div class="w-40">
              <VSelect
                :model-value="form.contractData.minLeaseTermUnit"
                :options="[
                  { label: 'days', value: 'days' },
                  { label: 'months', value: 'months' },
                  { label: 'years', value: 'years' },
                ]"
                @onChange="
                  (value) => {
                    form.contractData.minLeaseTermUnit = value
                  }
                "
                :searchable="false"
              >
                Unit
              </VSelect>
            </div>
          </div>

          <!-- Advance Rental -->
          <div class="mb-2 flex gap-2 w-full">
            <div class="w-72">
              <Input
                id="advance_rental_value"
                type="number"
                min="1"
                max="12"
                :model-value="form.contractData.advanceRentalValue"
                @change="
                  (value) => (form.contractData.advanceRentalValue = value)
                "
              >
                Advance Rental
              </Input>
            </div>
            <div class="w-40">
              <VSelect
                :model-value="form.contractData.advanceRentalUnit"
                :options="[
                  { label: 'days', value: 'days' },
                  { label: 'months', value: 'months' },
                  { label: 'years', value: 'years' },
                ]"
                @onChange="
                  (value) => {
                    form.contractData.advanceRentalUnit = value
                  }
                "
                :searchable="false"
              >
                Unit
              </VSelect>
            </div>
          </div>

          <!-- Security Deposit -->
          <div class="mb-2 flex gap-2 w-full">
            <div class="w-72">
              <Input
                id="security_deposit_value"
                type="number"
                min="1"
                max="12"
                :model-value="form.contractData.securityDepositValue"
                @change="
                  (value) => (form.contractData.securityDepositValue = value)
                "
              >
                Security Deposit
              </Input>
            </div>
            <div class="w-40">
              <VSelect
                :model-value="form.contractData.securityDepositUnit"
                :options="[
                  { label: 'days', value: 'days' },
                  { label: 'months', value: 'months' },
                  { label: 'years', value: 'years' },
                ]"
                @onChange="
                  (value) => {
                    form.contractData.securityDepositUnit = value
                  }
                "
                :searchable="false"
              >
                Unit
              </VSelect>
            </div>
          </div>
        </div>

        <div class="mb-2">
          <Input
            id="total_amount_to_be_paid_upfront"
            type="number"
            min="1"
            max="12"
            :model-value="form.contractData.totalAmountToBePaidUpfront"
            @change="
              (value) => (form.contractData.totalAmountToBePaidUpfront = value)
            "
          >
            Total amount to be paid upfront (advance rental + security deposit)
          </Input>
        </div>
      </div>
    </div>

    <!-- Step 2: Contact Person -->
    <div v-show="step === 2">
      <div class="mb-4">
        <ContactPicker
          label="Link lessor contact (optional)"
          :selected="form.lessorData.selectedContact"
          @select="onLessorContactSelect"
          @clear="onLessorContactClear"
        />
      </div>
      <div
        class="w-full gap-4 mb-4 sm:grid sm:grid-cols-2 md:grid md:grid-cols-2 lg:grid lg:grid-cols-2"
      >
        <!-- Contact Person Name -->
        <div class="mb-2">
          <Input
            id="contact_person_name"
            type="text"
            :model-value="form.lessorData.contactPersonName"
            @change="(value) => (form.lessorData.contactPersonName = value)"
            required
            :error="errors.contact_person_name"
            :error-message-invisible="!errors.contact_person_name"
          >
            Contact Person Name
          </Input>
        </div>
        <!-- Contact Person Designation -->
        <div class="mb-2">
          <Input
            id="contact_person_designation"
            type="text"
            :model-value="form.lessorData.contactPersonDesignation"
            @change="
              (value) => (form.lessorData.contactPersonDesignation = value)
            "
            required
            :error="errors.contact_person_designation"
            :error-message-invisible="!errors.contact_person_designation"
          >
            Contact Person Designation
          </Input>
        </div>
        <!-- Contact Person Gender -->
        <div class="mb-2">
          <VSelect
            id="contact_person_gender"
            :model-value="form.lessorData.contactPersonGender"
            :options="[
              { label: 'Male', value: 'male' },
              { label: 'Female', value: 'female' },
            ]"
            :searchable="false"
          >
            Contact Person Gender
          </VSelect>
        </div>
      </div>
    </div>

    <!-- Step 3: Client Information -->
    <div v-show="step === 3">
      <div class="mb-4">
        <ContactPicker
          label="Link lessee contact (optional)"
          :selected="form.lesseeData.selectedContact"
          @select="onLesseeContactSelect"
          @clear="onLesseeContactClear"
        />
      </div>
      <div
        class="w-full gap-4 mb-4 sm:grid sm:grid-cols-2 md:grid md:grid-cols-2 lg:grid lg:grid-cols-2"
      >
        <!-- First Name -->
        <div class="mb-2">
          <Input
            id="first_name"
            type="text"
            :model-value="form.lesseeData.firstName"
            @change="(value) => (form.lesseeData.firstName = value)"
            required
            :error="errors.first_name"
          >
            First Name
          </Input>
        </div>
        <!-- Last Name -->
        <div class="mb-2">
          <Input
            id="last_name"
            type="text"
            :model-value="form.lesseeData.lastName"
            @change="(value) => (form.lesseeData.lastName = value)"
            required
            :error="errors.last_name"
          >
            Last Name
          </Input>
        </div>
        <!-- Leasing Period -->
        <div class="mb-2">
          <VSelect
            id="leasing_period"
            :model-value="form.lesseeData.leasingPeriod"
            :options="[
              { label: 'Minimum Lease Term - 1 year', value: 'min_1_year' },
              { label: '6 months', value: '6_months' },
              { label: '1 year', value: '1_year' },
              { label: '2 years', value: '2_years' },
              { label: '3 years', value: '3_years' },
            ]"
            :searchable="false"
          >
            Leasing Period
          </VSelect>
        </div>
        <!-- Nationality -->
        <div class="mb-2">
          <Input
            id="nationality"
            type="text"
            :model-value="form.lesseeData.nationality"
            @change="(value) => (form.lesseeData.nationality = value)"
            required
          >
            Nationality
          </Input>
        </div>
        <!-- Status -->
        <div class="mb-2">
          <VSelect
            id="status"
            :options="[
              { label: 'Single', value: 'single' },
              { label: 'Married', value: 'married' },
              { label: 'Widowed', value: 'widowed' },
            ]"
            :model-value="form.lesseeData.status"
            @change="(value) => (form.lesseeData.status = value)"
            :searchable="false"
          >
            Status
          </VSelect>
        </div>
        <!-- Gender -->
        <div class="mb-2">
          <VSelect
            id="gender"
            :options="[
              { label: 'Male', value: 'male' },
              { label: 'Female', value: 'female' },
            ]"
            :model-value="form.lesseeData.gender"
            @change="(value) => (form.lesseeData.gender = value)"
            :searchable="false"
            :error="errors.lessee_gender"
            required
          >
            Gender
          </VSelect>
        </div>
        <!-- Company Name -->
        <div class="mb-2">
          <Input
            id="company_name"
            type="text"
            :model-value="form.lesseeData.companyName"
            @change="(value) => (form.lesseeData.companyName = value)"
            required
            :error="errors.company_name"
          >
            Company Name
          </Input>
        </div>
        <!-- Company Designation -->
        <div class="mb-2">
          <Input
            id="company_designation"
            type="text"
            :model-value="form.lesseeData.companyDesignation"
            @change="(value) => (form.lesseeData.companyDesignation = value)"
            required
            :error="errors.company_designation"
          >
            Company Designation/Position
          </Input>
        </div>
        <!-- Company Address -->
        <div class="mb-2">
          <Input
            id="company_address"
            type="text"
            :model-value="form.lesseeData.companyAddress"
            @change="(value) => (form.lesseeData.companyAddress = value)"
            required
            :error="errors.company_address"
          >
            Company Address
          </Input>
        </div>
      </div>
    </div>

    <!-- Letter Details -->
    <div v-show="step === 4">
      <div
        class="w-full gap-4 mb-4 sm:grid sm:grid-cols-2 md:grid md:grid-cols-2 lg:grid lg:grid-cols-2"
      >
        <!-- Date of Earnest Money -->
        <div class="mb-2">
          <Input
            id="earnest_money_date"
            type="date"
            :model-value="form.letterData.earnestMoneyDate"
            @change="(value) => (form.letterData.earnestMoneyDate = value)"
            required
            :error="errors.earnest_money_date"
          >
            Date of Earnest Money
          </Input>
        </div>

        <!-- Letter Validity -->
        <div class="mb-2">
          <Input
            id="letter_validity"
            type="date"
            :model-value="form.letterData.letterValidity"
            @change="(value) => (form.letterData.letterValidity = value)"
            required
            :error="errors.letter_validity"
          >
            Letter Validity
          </Input>
        </div>
      </div>

      <div class="mb-4">
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="reservation_items"
              v-model="form.letterData.reservationItems"
            />
            <label for="reservation_items">Reservation Items</label>
          </div>
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="lessor_fail"
              v-model="form.letterData.lessorFail"
            />
            <label for="lessor_fail"
              >"Should the Lessor fail to complete..."</label
            >
          </div>
        </div>
      </div>

      <button
        type="button"
        class="px-4 py-2 mb-4 text-white bg-primary rounded-lg col-span-2"
        @click="addRequest"
      >
        Add Request
      </button>
      <div
        class="mb-4 items-center"
        v-for="(request, index) in form.letterData.requests"
        :key="index"
      >
        <div class="flex gap-2 items-end">
          <div class="max-w-7 md:max-w-[3vw]">
            <Input readonly type="text" :model-value="index + 1">No.</Input>
          </div>
          <Input
            id="request"
            type="text"
            :model-value="request.value"
            @change="(value) => (request.value = value)"
            class="flex-1"
          >
            Request
          </Input>
          <button
            type="button"
            class="px-4 py-2 text-white bg-destructive h-[40px] rounded-lg"
            @click="removeRequest(index)"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
    <div class="flex flex-col sm:flex-row mt-auto gap-2">
      <button
        type="button"
        class="mr-auto rounded-lg w-full sm:w-39 h-9 bg-green bg-opacity-20 hover:bg-green-dark hover:bg-opacity-30"
        @click="previousStep"
        v-show="step > 1"
      >
        <span class="inline-block text-green font-bold mt-0.5">Previous</span>
      </button>
      <button
        type="button"
        class="ml-auto rounded-lg w-full sm:w-39 h-9 bg-green bg-opacity-20 hover:bg-green-dark hover:bg-opacity-30"
        @click="nextStep"
        v-show="step < 4"
      >
        <span class="inline-block text-green font-bold mt-0.5">Next</span>
      </button>
      <button
        type="button"
        class="ml-auto rounded-lg w-full sm:w-39 h-9 bg-green"
        @click="generateResidentialLOIContract"
        v-show="step === 4"
      >
        <span class="inline-block text-white font-bold mt-0.5">Generate</span>
      </button>
    </div>
  </section>
</template>

<script setup>
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import ContactPicker from '~/components/contacts/ContactPicker.vue'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import { generateLOICall } from '~/services/document.services'

const step = ref(1)
const propertyOptions = ref([])
const errors = reactive({})
const form = reactive({
  contractData: {
    propertyDivision: '',
    propertyCategory: '',
    propertyTitle: '',
    propertyFloorArea: '',
    propertyAddress: '',
    propertyPrice: '',
    propertyCondition: '',
    leaseStartDate: '',
    minLeaseTermValue: '',
    minLeaseTermUnit: '',
    advanceRentalValue: '',
    advanceRentalUnit: '',
    securityDepositValue: '',
    securityDepositUnit: '',
    totalAmountToBePaidUpfront: '',
  },
  lessorData: {
    // Cross-entity link to a contact — surfaces document on the
    // contact's unified timeline. The generator already pulls
    // contact_id from formData.lessorData.contact_id.
    contact_id: null,
    selectedContact: null,
    contactPersonName: '',
    contactPersonDesignation: '',
    contactPersonGender: '',
  },
  lesseeData: {
    contact_id: null,
    selectedContact: null,
    firstName: '',
    lastName: '',
    leasingPeriod: '',
    nationality: '',
    status: '',
    gender: '',
    companyName: '',
    companyDesignation: '',
    companyAddress: '',
  },
  letterData: {
    earnestMoneyDate: '',
    letterValidity: '',
    reservationItems: false,
    lessorFail: false,
    requests: [],
  },
})

function formatPrice(price) {
  // Remove any non-digit characters first, just to be safe
  const cleaned = price.replace(/\D/g, '')
  return cleaned.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function onLessorContactSelect(contact) {
  form.lessorData.contact_id = contact?.id ?? null
  form.lessorData.selectedContact = contact ?? null
  if (!contact) return
  form.lessorData.contactPersonName =
    contact.full_name || form.lessorData.contactPersonName
  form.lessorData.contactPersonDesignation =
    contact.designation || form.lessorData.contactPersonDesignation
}
function onLessorContactClear() {
  form.lessorData.contact_id = null
  form.lessorData.selectedContact = null
}

function onLesseeContactSelect(contact) {
  form.lesseeData.contact_id = contact?.id ?? null
  form.lesseeData.selectedContact = contact ?? null
  if (!contact) return
  // Best-effort split of full_name into first / last when the user
  // hasn't filled them yet.
  if (contact.full_name && !form.lesseeData.firstName && !form.lesseeData.lastName) {
    const parts = contact.full_name.trim().split(/\s+/)
    form.lesseeData.firstName = parts.shift() ?? ''
    form.lesseeData.lastName = parts.join(' ')
  }
}
function onLesseeContactClear() {
  form.lesseeData.contact_id = null
  form.lesseeData.selectedContact = null
}

onMounted(async () => {
  const propertyDetails = await fetchPropertyDetails()

  console.log('propertyDetails: ', propertyDetails)

  propertyOptions.value = propertyDetails.map((listing) => ({
    id: listing.listing_id,
    label: `ID ${listing.listing_id} - ${listing.title}`,
    streetAddress: listing.street_address,
    propertyFloorArea: listing.floor_area,
    propertyCondition: listing.condition,
  }))
})

async function handleCategoryChange(category) {
  console.log('category: ', category)
  const propertyDetails = await fetchPropertyDetails(
    form.contractData.propertyDivision.value,
    category.value
  )

  propertyOptions.value = propertyDetails.map((listing) => ({
    id: listing.listing_id,
    label: `ID ${listing.listing_id} - ${listing.title}`,
    streetAddress: listing.street_address,
  }))
}

async function handleDivisionChange(division) {
  console.log('division: ', division)
  const propertyDetails = await fetchPropertyDetails(
    division.value,
    form.contractData.propertyCategory.value
  )

  propertyOptions.value = propertyDetails.map((listing) => ({
    id: listing.listing_id,
    label: `ID ${listing.listing_id} - ${listing.title}`,
    streetAddress: listing.street_address,
  }))
}

async function fetchPropertyDetails(division, category) {
  showLoading()
  const nuxtApp = useNuxtApp()

  // Reads from `listing_details` (canonical wide read source).
  const query = useSupabaseClient()
    .from('listing_details')
    .select(
      'listing_id, title, street_address, property_category, for_rent, for_sale'
    )

  let queryBuilder = query

  if (division) {
    queryBuilder = queryBuilder.eq('property_category', 'residential')
  }

  if (category) {
    if (category === 'rent') {
      queryBuilder = queryBuilder.eq('for_rent', true)
    } else {
      queryBuilder = queryBuilder.eq('for_sale', true)
    }
  }

  if (!division && !category) {
    queryBuilder = queryBuilder.eq('property_category', 'residential')
    queryBuilder = queryBuilder.eq('for_rent', true)
  }

  const { data: propertyDetails, error: propertyDetailsError } =
    await queryBuilder

  dismissLoading()
  if (propertyDetailsError) {
    console.error('Error fetching property details:', propertyDetailsError)
    return
  }

  return propertyDetails
}

const addRequest = () => {
  form.letterData.requests.push({
    value: '',
    unit: '',
  })
}

const removeRequest = (index) => {
  form.letterData.requests.splice(index, 1)
}

const validateStep1 = () => {
  if (!form.contractData.propertyTitle || !form.contractData.leaseStartDate) {
    errors.property_title =
      'Property Title and Lease Starting Date are required'
    errors.lease_start_date =
      'Property Title and Lease Starting Date are required'
    return false
  }
  errors.property_title = ''
  errors.lease_start_date = ''
  return true
}

const validateStep2 = () => {
  let isValid = true

  if (
    !form.lessorData.contactPersonName ||
    !form.lessorData.contactPersonDesignation ||
    !form.lessorData.contactPersonGender
  ) {
    isValid = false
  }

  return isValid
}

const changeStep = (newStep) => {
  switch (step.value) {
    case 1:
      if (validateStep1()) {
        step.value = newStep
      }
      break
    case 2:
      if (validateStep2()) {
        step.value = newStep
      }
      break
    default:
      step.value = newStep
      break
  }
}
const nextStep = () => {
  switch (step.value) {
    case 1:
      console.log('case 1 step: ', step.value)
      if (validateStep1()) {
        step.value++
      }
      break
    default:
      console.log('default step: ', step.value)
      step.value++
      break
  }
}

const previousStep = () => {
  step.value--
}

async function generateResidentialLOIContract() {
  showLoading()

  const document = await generateLOICall(form)
  console.log('document: ', document)

  if (document) {
    dismissLoading()
    showToast({
      title:
        'Letter of Intent Document generated successfully. Check you the Document Checklist',
      icon: 'success',
    })
  }
}
</script>
