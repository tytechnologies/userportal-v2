<template>
  <section class="flex flex-col h-full overflow-y-auto max-h-[70vh]">
    <h3 class="mb-4 text-2xl font-black">Property Management Agreement</h3>
    <p class="text-sm font-medium text-muted-foreground mb-9">
      This form authorizes a real estate broker (HOUSINGINTERACTIVE INC.) to
      sell a specified residential unit on behalf of the owner. It includes<br />
      details about the property, broker's responsibilities, required documents,
      selling price, commission structure, and terms of the agreement. <br />
      The form also outlines conditions for termination and renewal of the
      authority to sell.
    </p>

    <ul
      class="hidden w-full leading-10 rounded-lg sm:flex md:flex lg:flex bg-muted/30 mb-9"
    >
      <li :class="'flex-1 text-center font-bold rounded-lg ' + (step === 1 ? 'bg-primary/10 text-primary' : '')">
        Property
      </li>
      <li :class="'flex-1 text-center font-bold rounded-lg ' + (step === 2 ? 'bg-primary/10 text-primary' : '')">
        Owner Information
      </li>
      <li :class="'flex-1 text-center font-bold rounded-lg ' + (step === 3 ? 'bg-primary/10 text-primary' : '')">
        Property Manager & Details
      </li>
    </ul>

    <!-- Step 1: Property -->
    <div v-show="step === 1" class="grid grid-cols-2 gap-4">
      <div class="mb-2 col-span-2">
        <VSelect
          id="property_id"
          :model-value="form.propertyData.id"
          @option:selected="onPropertySelect"
          :options="availableProperties"
          placeholder="Select Property"
          >Property</VSelect
        >
      </div>
    </div>

    <!-- Step 2: Owner Information -->
    <div v-show="step === 2" class="grid grid-cols-2 gap-4">
      <!-- Optional contact picker. Selecting an existing contact stamps
           form.ownerData.contact_id, which the generator threads into
           documents.metadata so the resulting document.uploaded audit
           row appears on this contact's unified timeline. Manual entry
           still works for ad-hoc owners. -->
      <div class="mb-4 col-span-2">
        <ContactPicker
          label="Link to existing contact (optional)"
          :selected="form.ownerData.selectedContact"
          @select="onOwnerContactSelect"
          @clear="onOwnerContactClear"
        />
      </div>

      <!-- Owner's Name -->
      <div class="mb-2">
        <Input
          id="owner_name"
          label="Owner's Name"
          required
          :model-value="form.ownerData.ownerName"
          @change="(value) => (form.ownerData.ownerName = value)"
          >Owner's Name</Input
        >
      </div>

      <!-- Owner's Nationality -->
      <div class="mb-2">
        <Input
          id="owner_nationality"
          label="Owner's Nationality"
          required
          :model-value="form.ownerData.ownerNationality"
          @change="(value) => (form.ownerData.ownerNationality = value)"
          >Owner's Nationality</Input
        >
      </div>

      <!-- Owner's Address -->
      <div class="mb-2 col-span-2">
        <Input
          id="owner_address"
          label="Owner's Address"
          required
          :model-value="form.ownerData.ownerAddress"
          @change="(value) => (form.ownerData.ownerAddress = value)"
          >Owner's Address</Input
        >
      </div>
    </div>

    <!-- Step 3: Property Manager & Details -->
    <div v-show="step === 3" class="grid grid-cols-2 gap-4">
      <div class="mb-2 col-span-2">
        <Input
          id="property_manager_name"
          label="Property Manager Name"
          required
          :model-value="form.propertyData.propertyManagerName"
          @change="(value) => (form.propertyData.propertyManagerName = value)"
          >Property Manager Name</Input
        >
      </div>
      <div class="mb-2">
        <Input
          id="property_address"
          label="Property Address"
          :model-value="form.propertyData.propertyAddress"
          @change="(value) => (form.propertyData.propertyAddress = value)"
          >Property Address</Input
        >
      </div>
      <div class="mb-2">
        <Input
          id="property_city"
          label="Property City"
          :model-value="form.propertyData.propertyCity"
          @change="(value) => (form.propertyData.propertyCity = value)"
          >Property City</Input
        >
      </div>
      <div class="mb-2">
        <Input
          id="property_parking_spaces"
          label="Parking Spaces"
          :model-value="form.propertyData.propertyParkingSpaces"
          @change="(value) => (form.propertyData.propertyParkingSpaces = value)"
          >Parking Spaces</Input
        >
      </div>
      <div class="mb-2">
        <Input
          id="signature_date"
          label="Signature Date"
          type="date"
          :model-value="form.contractData.signatureDate"
          @change="(value) => (form.contractData.signatureDate = value)"
          >Signature Date</Input
        >
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
        @click="generatePropertyManagementAgreement"
        v-show="step === 3"
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
import { generatePropertyManagementAgreementCall } from '~/services/document.services'

const availableProperties = ref([])
const step = ref(1)
const form = reactive({
  ownerData: {
    // contact_id flows into documents.metadata so the generated audit
    // row pivots onto the contact's unified timeline. selectedContact
    // is the picker's controlled state.
    contact_id: null,
    selectedContact: null,
    ownerName: '',
    ownerNationality: '',
    ownerHomeAddress: '',
    ownerAddress: '',
    ownerEmailAddress: '',
    ownerTelephoneNumber: '',
  },
  propertyData: {
    id: '',
    propertyAddress: '',
    propertyParkingSpaces: '',
    propertyCity: '',
    propertyManagerName: '',
  },
  contractData: {
    signatureDate: '',
  },
})

function onOwnerContactSelect(contact) {
  form.ownerData.contact_id = contact?.id ?? null
  form.ownerData.selectedContact = contact ?? null
  if (!contact) return
  form.ownerData.ownerName = contact.full_name || form.ownerData.ownerName
  form.ownerData.ownerEmailAddress =
    contact.email || form.ownerData.ownerEmailAddress
  form.ownerData.ownerTelephoneNumber =
    contact.mobile_phone || contact.home_phone || form.ownerData.ownerTelephoneNumber
}

function onOwnerContactClear() {
  form.ownerData.contact_id = null
  form.ownerData.selectedContact = null
}

function onPropertySelect(property) {
  if (property) {
    form.propertyData.id = property.value || property.id
    form.propertyData.propertyAddress = property.street_address || ''
    form.propertyData.propertyParkingSpaces = property.parking_spaces ? String(property.parking_spaces) : ''
    form.propertyData.propertyCity = property.city_name || ''
  }
}

onMounted(async () => {
  // Reads from `listing_details` (canonical wide read source — exposes
  // city_name via the join).
  const { data: listingDetails, error: listingDetailsError } =
    await useSupabaseClient()
      .from('listing_details')
      .select('listing_id, title, street_address, parking_spaces, city_name')
      .order('updated_at', { ascending: false })

  if (listingDetailsError) {
    console.error('Error fetching listing details:', listingDetailsError)
    return
  }

  const list = listingDetails || []
  availableProperties.value = list.map((listing) => ({
    id: listing.listing_id,
    value: listing.listing_id,
    label: `ID ${listing.listing_id} - ${listing.title || 'Untitled'}`,
    text: listing.title,
    street_address: listing.street_address,
    parking_spaces: listing.parking_spaces,
    city_name: listing.city_name,
  }))

  const now = new Date()
  form.contractData.signatureDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
})

function previousStep() {
  step.value--
}

function nextStep() {
  step.value++
}
async function generatePropertyManagementAgreement() {
  showLoading()
  try {
    const fileUrl = await generatePropertyManagementAgreementCall(form)
    dismissLoading()
    showToast({
      title: 'Property Management Agreement document generated successfully. Check your Document Checklist',
      icon: 'success',
    })
    if (fileUrl) window.open(fileUrl, '_blank')
  } catch (err) {
    dismissLoading()
    showToast({
      title: err?.message || 'Failed to generate document',
      icon: 'error',
    })
  }
}
</script>
