<template>
  <section class="flex flex-col h-full overflow-y-auto max-h-[70vh]">
    <h3 class="mb-4 text-2xl font-black">Authority to Sell</h3>
    <p class="text-sm font-medium text-muted-foreground mb-9">
      This form authorizes a real estate broker (HOUSINGINTERACTIVE INC.) to
      sell a specified residential unit on behalf of the owner. It includes<br />
      details about the property, broker's responsibilities, required documents,
      selling price, commission structure, and terms of the agreement. <br />
      The form also outlines conditions for termination and renewal of the
      authority to sell.
    </p>

    <div class="text-lg font-bold w-full my-4 px-2">Property Details</div>
    <div class="grid sm:grid-cols-2 gap-4">
      <!-- Property Name and address -->
      <div class="mb-2 col-span-2">
        <VSelect
          id="property_id"
          :model-value="form.property.id"
          @option:selected="onPropertySelect"
          placeholder="Select property"
          :options="availableProperties"
          >Property</VSelect
        >
      </div>

      <!-- Property Title Number (optional, not from listing) -->
      <div class="mb-2 col-span-2 sm:col-span-1">
        <Input
          id="property_title_number"
          label="Title Number"
          type="text"
          :model-value="form.property.property_title_number"
          @change="(value) => (form.property.property_title_number = value)"
          >Title Number</Input
        >
      </div>

      <!-- Selling Price (pre-filled from selection) -->
      <div class="mb-2 col-span-2 sm:col-span-1">
        <Input
          id="property_selling_price"
          label="Selling Price"
          type="text"
          :model-value="form.property.selling_price"
          @change="(value) => (form.property.selling_price = value)"
          >Selling Price</Input
        >
      </div>

      <!-- Optional contact picker. When the owner exists in the
           contacts directory, picking them auto-fills name + address +
           phone + email, AND stamps form.ownerData.contact_id so the
           generated document audit-logs `metadata.contact_id` and shows
           up on this contact's unified timeline. Manual entry is still
           supported for ad-hoc owners. -->
      <div class="mb-4 col-span-2">
        <ContactPicker
          label="Link to existing contact (optional)"
          :selected="form.ownerData.selectedContact"
          @select="onOwnerContactSelect"
          @clear="onOwnerContactClear"
        />
      </div>

      <!-- Owner's Name -->
      <div class="mb-2 col-span-2 sm:col-span-1">
        <Input
          id="owner_name"
          label="Owner's Name"
          required
          type="text"
          :model-value="form.ownerData.ownerName"
          @change="(value) => (form.ownerData.ownerName = value)"
          >Owner's Name
        </Input>
      </div>

      <!-- Owner's Nationality -->
      <div class="mb-2 col-span-2 sm:col-span-1">
        <Input
          id="owner_nationality"
          label="Owner's Nationality"
          required
          type="text"
          :model-value="form.ownerData.ownerNationality"
          @change="(value) => (form.ownerData.ownerNationality = value)"
          >Owner's Nationality
        </Input>
      </div>

      <!-- Owner's Home Address -->
      <div class="mb-2 col-span-2 sm:col-span-1">
        <Input
          id="owner_home_address"
          label="Owner's Home Address"
          required
          type="text"
          :model-value="form.ownerData.ownerHomeAddress"
          @change="(value) => (form.ownerData.ownerHomeAddress = value)"
          >Owner's Home Address
        </Input>
      </div>

      <!-- Owner's Telephone Number -->
      <div class="mb-2 col-span-2 sm:col-span-1">
        <Input
          id="owner_telephone_number"
          label="Owner's Telephone Number"
          required
          type="text"
          :model-value="form.ownerData.ownerTelephoneNumber"
          @change="(value) => (form.ownerData.ownerTelephoneNumber = value)"
          >Owner's Telephone Number
        </Input>
      </div>

      <!-- Owner's Address -->
      <div class="mb-2 col-span-2">
        <Input
          id="owner_address"
          label="Owner's Address"
          required
          type="text"
          :model-value="form.ownerData.ownerAddress"
          @change="(value) => (form.ownerData.ownerAddress = value)"
          >Owner's Address
        </Input>
      </div>
    </div>
    <div class="flex mt-auto">
      <button
        type="button"
        class="ml-auto rounded-lg w-39 h-9 bg-green"
        @click="generateAuthorityToSellContract"
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
import { generateAuthorityToSellCall } from '~/services/document.services'

const availableProperties = ref([])

const form = reactive({
  property: {
    id: '',
    name: '',
    address: '',
    property_title_number: '',
    total_floor_area: '',
    selling_price: '',
  },
  ownerData: {
    // contact_id is read by the generator and stamped into
    // documents.metadata.contact_id, which makes the resulting
    // document.uploaded audit row pivot onto this contact's unified
    // timeline. selectedContact is the picker's controlled state — it
    // tracks the picked row so the picker can render in "selected" mode
    // across re-renders.
    contact_id: null,
    selectedContact: null,
    ownerName: '',
    ownerNationality: '',
    ownerHomeAddress: '',
    ownerEmailAddress: '',
    ownerTelephoneNumber: '',
    ownerAddress: '',
  },
  signatureDate: '',
})

// When the user picks an existing contact, copy as much as we have onto
// the form. Fields the contact doesn't carry (nationality) stay blank
// for the user to fill manually.
function onOwnerContactSelect(contact /** : Contact */) {
  form.ownerData.contact_id = contact?.id ?? null
  form.ownerData.selectedContact = contact ?? null
  if (!contact) return
  form.ownerData.ownerName = contact.full_name || form.ownerData.ownerName
  form.ownerData.ownerEmailAddress = contact.email || form.ownerData.ownerEmailAddress
  form.ownerData.ownerTelephoneNumber =
    contact.mobile_phone || contact.home_phone || form.ownerData.ownerTelephoneNumber
}

function onOwnerContactClear() {
  form.ownerData.contact_id = null
  form.ownerData.selectedContact = null
  // Don't wipe the manually-filled fields — user might still want them.
}

function onPropertySelect(property) {
  if (property) {
    form.property.id = property.value || property.id
    form.property.name = property.property_name || property.text || ''
    form.property.address = property.street_address || ''
    form.property.total_floor_area = property.floor_area ? String(property.floor_area) : ''
    form.property.selling_price = String(property.sale_price ?? property.rent_price ?? '')
  }
}

onMounted(async () => {
  // Reads from `listing_details` (canonical wide read source).
  const { data: listingDetails, error: listingDetailsError } =
    await useSupabaseClient()
      .from('listing_details')
      .select('listing_id, title, property_name, street_address, floor_area, sale_price, rent_price')
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
    property_name: listing.property_name,
    street_address: listing.street_address,
    floor_area: listing.floor_area,
    sale_price: listing.sale_price,
    rent_price: listing.rent_price,
  }))

  const now = new Date()
  form.signatureDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
})

async function generateAuthorityToSellContract() {
  showLoading()
  try {
    const fileUrl = await generateAuthorityToSellCall(form)
    dismissLoading()
    showToast({
      title: 'Authority to Sell document generated successfully. Check your Document Checklist',
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
