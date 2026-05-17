<template>
  <section class="flex flex-col h-full">
    <h3 class="mb-4 text-2xl font-black">Contract of Lease</h3>

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
        Lessor Information
      </li>
      <li
        :class="
          'cursor-pointer hover:bg-primary/10 flex-1 text-center font-bold rounded-lg ' +
          (step === 3 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Lessee Information
      </li>
    </ul>

    <!-- Step 1: Property -->
    <div v-show="step === 1">
      <div
        class="w-full gap-4 mb-4 sm:grid sm:grid-cols-2 md:grid md:grid-cols-2 lg:grid lg:grid-cols-2"
      >
        <!-- Property -->
        <div class="mb-2 col-span-2">
          <VSelect
            required
            id="property_id"
            :model-value="form.propertyDetails.property?.id"
            @option:selected="onPropertyChanged"
            placeholder="Select property"
            :options="availableProperties"
            >Property</VSelect
          >
        </div>

        <!-- Name -->
        <div class="mb-2">
          <Input
            id="name"
            type="text"
            :model-value="form.propertyDetails.property.building_name"
            @change="
              (value) => (form.propertyDetails.property.building_name = value)
            "
            required
            >Property/Building Name</Input
          >
        </div>

        <!-- Property Price -->
        <div class="mb-2">
          <Input
            id="property_price"
            placeholder="0.00"
            type="text"
            :model-value="formatPrice(form.propertyDetails.property_price)"
            @change="(value) => (form.propertyDetails.property_price = value)"
            required
            >Property Price</Input
          >
        </div>

        <!-- Property Floor Area -->
        <div class="mb-2">
          <Input
            id="property_floor_area"
            placeholder="0.00"
            type="number"
            min="0"
            :model-value="form.propertyDetails.property_floor_area"
            @change="
              (value) => (form.propertyDetails.property_floor_area = value)
            "
            required
            >Property Floor Area</Input
          >
        </div>

        <!-- Lease Starting Date -->
        <div class="mb-2">
          <Input
            id="lease_starting_date"
            type="date"
            date-format="F j, Y"
            date-placeholder=""
            :model-value="form.propertyDetails.lease_starting_date"
            @change="
              (value) => (form.propertyDetails.lease_starting_date = value)
            "
            required
            >Lease Starting Date</Input
          >
        </div>
      </div>
      <div
        class="w-full gap-4 mb-4 sm:grid sm:grid-cols-3 md:grid md:grid-cols-3 lg:grid lg:grid-cols-3"
      >
        <!-- Minimum Lease Term -->
        <div class="relative mb-2">
          <label for="lease_term" class="mb-2 text-sm font-bold text-foreground"
            >Lease Term <span class="text-red">*</span></label
          >
          <div class="flex mb-2">
            <div class="w-1/2 mr-1">
              <Input
                id="lease_term"
                type="number"
                :min="0"
                :model-value="form.propertyDetails.lease_term"
                placeholder="0"
                @change="(value) => (form.propertyDetails.lease_term = value)"
                error-message-invisible
              />
            </div>
            <div class="w-1/2 ml-1">
              <VSelect
                v-model="form.propertyDetails.lease_term_unit"
                placeholder="Select unit"
                :clearable="false"
                error-message-invisible
                :options="rateUnits"
                label="text"
                :reduce="(item) => item.id"
              />
            </div>
          </div>
        </div>

        <!-- Advance Rental -->
        <div class="relative mb-2">
          <label for="advance" class="mb-2 text-sm font-bold text-foreground"
            >Advance Rental <span class="text-red">*</span></label
          >
          <div class="flex mb-2">
            <div class="w-1/2 mr-1">
              <Input
                id="advance"
                type="number"
                :min="0"
                :model-value="form.propertyDetails.advance"
                @change="(value) => (form.propertyDetails.advance = value)"
                placeholder="0"
                error-message-invisible
              />
            </div>
            <div class="w-1/2 ml-1">
              <VSelect
                v-model="form.propertyDetails.advance_unit"
                placeholder="Select unit"
                :clearable="false"
                error-message-invisible
                :options="rateUnits"
                label="text"
                :reduce="(item) => item.id"
              />
            </div>
          </div>
        </div>

        <!-- Security Deposit -->
        <div class="relative mb-2">
          <label for="deposit" class="mb-2 text-sm font-bold text-foreground"
            >Security Deposit <span class="text-red">*</span></label
          >
          <div class="flex mb-2">
            <div class="w-1/2 mr-1">
              <Input
                id="deposit"
                type="number"
                :min="0"
                :model-value="form.propertyDetails.deposit"
                placeholder="0"
                @change="(value) => (form.propertyDetails.deposit = value)"
                error-message-invisible
                required
              />
            </div>
            <div class="w-1/2 ml-1">
              <VSelect
                v-model="form.propertyDetails.deposit_unit"
                placeholder="Select unit"
                :clearable="false"
                error-message-invisible
                :options="rateUnits"
                label="text"
                :reduce="(item) => item.id"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 2: Lessor Information -->
    <div v-show="step === 2">
      <div class="mb-4">
        <ContactPicker
          label="Link lessor to existing contact (optional)"
          :selected="form.lessorDetails.selectedContact"
          @select="onLessorContactSelect"
          @clear="onLessorContactClear"
        />
      </div>

      <div class="grid w-full lg:grid-cols-2 gap-4 mb-4">
        <!-- Name -->
        <div class="mb-2">
          <Input
            id="lessor_name"
            type="text"
            :model-value="form.lessorDetails.lessor_name"
            @change="(value) => (form.lessorDetails.lessor_name = value)"
            required
            >Full Name</Input
          >
        </div>

        <!-- Gender -->
        <div class="mb-2">
          <label class="mb-2 text-sm font-bold text-foreground"
            >Gender <span class="text-red">*</span></label
          >
          <div class="flex h-10 w-full">
            <VSelect
              v-model="form.lessorDetails.lessor_gender"
              :clearable="false"
              placeholder="Select gender"
              required
              :options="genders"
              label="text"
            />
          </div>
        </div>

        <!-- Nationality -->
        <div class="mb-2">
          <Input
            id="lessor_nationality"
            placeholder="Enter nationality"
            type="text"
            :model-value="form.lessorDetails.lessor_nationality"
            @change="(value) => (form.lessorDetails.lessor_nationality = value)"
            required
            >Nationality</Input
          >
        </div>

        <!-- Address -->
        <div class="mb-2">
          <Input
            id="lessor_address"
            type="text"
            :model-value="form.lessorDetails.lessor_address"
            @change="(value) => (form.lessorDetails.lessor_address = value)"
            required
            placeholder="Enter lessor address"
            >Address</Input
          >
        </div>
      </div>
    </div>

    <!-- Step 3: Lessee Information -->
    <div v-show="step === 3">
      <div class="mb-4">
        <ContactPicker
          label="Link lessee to existing contact (optional)"
          :selected="form.lesseeDetails.selectedContact"
          @select="onLesseeContactSelect"
          @clear="onLesseeContactClear"
        />
      </div>

      <div class="grid w-full grid-cols-3 gap-4 mb-4">
        <!-- Company Name -->
        <div class="mb-2">
          <Input
            id="lessee_name"
            type="text"
            :model-value="form.lesseeDetails.lessee_name"
            @change="(value) => (form.lesseeDetails.lessee_name = value)"
            required
            placeholder="Enter lessee name"
            >Full Name</Input
          >
        </div>

        <!-- Company Address -->
        <div class="mb-2 col-span-2">
          <Input
            id="lessee_address"
            type="text"
            :model-value="form.lesseeDetails.lessee_address"
            @change="(value) => (form.lesseeDetails.lessee_address = value)"
            required
            placeholder="Enter lessee address"
            >Address</Input
          >
        </div>

        <!-- Representative Name -->
        <div class="mb-2">
          <Input
            id="lessee_representative_name"
            type="text"
            :model-value="form.lesseeDetails.lessee_representative_name"
            @change="
              (value) => (form.lesseeDetails.lessee_representative_name = value)
            "
            required
            placeholder="Enter representative name"
            >Representative Name</Input
          >
        </div>

        <!-- Designation / Position -->
        <div class="mb-2">
          <Input
            id="lessee_designation"
            type="text"
            :model-value="form.lesseeDetails.lessee_designation"
            @change="(value) => (form.lesseeDetails.lessee_designation = value)"
            required
            placeholder="Enter designation"
            >Designation / Position</Input
          >
        </div>

        <!-- Gender -->
        <div class="mb-2">
          <label class="mb-2 text-sm font-bold text-foreground"
            >Gender <span class="text-red">*</span></label
          >
          <div class="flex h-10 w-full">
            <VSelect
              v-model="form.lesseeDetails.lessee_gender"
              :clearable="false"
              placeholder="Select gender"
              required
              :options="genders"
              label="text"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="flex flex-col items-stretch lg:flex-row gap-4 mt-auto">
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
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import ContactPicker from '~/components/contacts/ContactPicker.vue'
import { showToast, showLoading, dismissLoading } from '~/helpers/helpers'
import { generateCommercialContractOfLeaseCall } from '~/services/document.services'

export default {
  components: { Input, VSelect, ContactPicker },
  data() {
    return {
      availableProperties: [],
      genders: [
        { id: 'male', text: 'Male' },
        { id: 'female', text: 'Female' },
        { id: 'other', text: 'Other' },
      ],
      form: {
        propertyDetails: {
          property: {
            id: '', // Changed from property_id to id for consistency
            title: '',
            building_name: '',
          },
          property_price: '',
          property_floor_area: '',
          lease_starting_date: '',
          lease_term: '',
          lease_term_unit: '',
          advance: '',
          advance_unit: '',
          deposit: '',
          deposit_unit: '',
        },
        lessorDetails: {
          // Cross-entity link to a contact — surfaces document on the
          // contact's unified timeline. The form's submit handler also
          // promotes this id into the transformed ownerData payload
          // (lessor doubles as owner in this template).
          contact_id: null,
          selectedContact: null,
          lessor_name: '',
          lessor_gender: '',
          lessor_nationality: '',
          lessor_address: '',
        },
        lesseeDetails: {
          contact_id: null,
          selectedContact: null,
          lessee_name: '',
          lessee_address: '',
          lessee_representative_name: '',
          lessee_designation: '',
          lessee_gender: '',
        },
      },
      step: 1,
      rateUnits: [
        { id: 'month', text: 'Month(s)' },
        { id: 'year', text: 'Year(s)' },
      ],
    }
  },
  async mounted() {
    const { data: listingDetails, error: listingDetailsError } =
      await useSupabaseClient()
        // Reads from `listing_details` (canonical wide read source).
        .from('listing_details')
        .select('listing_id, title, property_name')
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
    }))
  },
  methods: {
    onLessorContactSelect(contact) {
      this.form.lessorDetails.contact_id = contact?.id ?? null
      this.form.lessorDetails.selectedContact = contact ?? null
      if (!contact) return
      this.form.lessorDetails.lessor_name =
        contact.full_name || this.form.lessorDetails.lessor_name
    },
    onLessorContactClear() {
      this.form.lessorDetails.contact_id = null
      this.form.lessorDetails.selectedContact = null
    },
    onLesseeContactSelect(contact) {
      this.form.lesseeDetails.contact_id = contact?.id ?? null
      this.form.lesseeDetails.selectedContact = contact ?? null
      if (!contact) return
      this.form.lesseeDetails.lessee_name =
        contact.full_name || this.form.lesseeDetails.lessee_name
    },
    onLesseeContactClear() {
      this.form.lesseeDetails.contact_id = null
      this.form.lesseeDetails.selectedContact = null
    },
    formatPrice(price) {
      // Remove any non-digit characters first, just to be safe
      const cleaned = price.replace(/\D/g, '')
      return cleaned.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    },
    nextStep() {
      if (this.step < 3) this.step++ // Changed from 5 to 3 to match template
    },
    previousStep() {
      if (this.step > 1) this.step--
    },
    
    // Handle property search/fetch
    onFetchProperties(query) {
      // This method is called when searching properties
      // The VSelect component handles the filtering automatically
      return this.availableProperties
    },
    
    // Handle property change (option from NewVSelect has id, label, text, property_name)
    onPropertyChanged(property) {
      if (property) {
        this.form.propertyDetails.property = {
          id: property.id,
          title: property.text || property.label,
          building_name: property.property_name || '',
        }
      }
    },
    
    // Add download link as backup
    addDownloadLink(fileUrl) {
      // Create a download link element
      const downloadDiv = document.createElement('div')
      downloadDiv.className = 'fixed top-4 right-4 bg-success text-success-foreground p-4 rounded-lg shadow-lg z-50'
      downloadDiv.innerHTML = `
        <div class="flex items-center space-x-2">
          <span>📄 Document Ready!</span>
          <a href="${fileUrl}" download="Commercial_Contract_of_Lease.docx"
             class="bg-card text-success px-3 py-1 rounded hover:bg-muted">
            Download
          </a>
          <button onclick="this.parentElement.parentElement.remove()"
                  class="bg-card text-success px-2 py-1 rounded hover:bg-muted">×</button>
        </div>
      `
      document.body.appendChild(downloadDiv)
      
      // Auto-remove after 10 seconds
      setTimeout(() => {
        if (downloadDiv.parentElement) {
          downloadDiv.remove()
        }
      }, 10000)
    },
    
    async generateCommercialContractOfLease() {
      // Validate required fields first
      if (!this.form.propertyDetails.property || !this.form.propertyDetails.property.id) {
        showToast({
          title: 'Validation Error',
          message: 'Please select a property',
          icon: 'error',
        })
        return
      }
      
      if (!this.form.lessorDetails.lessor_name) {
        showToast({
          title: 'Validation Error',
          message: 'Please enter the lessor name',
          icon: 'error',
        })
        return
      }
      
      if (!this.form.lesseeDetails.lessee_name) {
        showToast({
          title: 'Validation Error',
          message: 'Please enter the lessee name',
          icon: 'error',
        })
        return
      }
      
      if (!this.form.propertyDetails.lease_starting_date) {
        showToast({
          title: 'Validation Error',
          message: 'Please enter the lease starting date',
          icon: 'error',
        })
        return
      }
      
      if (!this.form.propertyDetails.lease_term || !this.form.propertyDetails.lease_term_unit) {
        showToast({
          title: 'Validation Error',
          message: 'Please enter the lease term and unit',
          icon: 'error',
        })
        return
      }
      
      if (!this.form.propertyDetails.property_price) {
        showToast({
          title: 'Validation Error',
          message: 'Please enter the property price',
          icon: 'error',
        })
        return
      }

      showLoading()
      
      try {
        // Transform the form data to match the expected structure
        const transformedData = {
          lessorData: {
            // contact_id is forwarded to the generator's metadata so
            // the resulting document.uploaded audit row pivots onto
            // the lessor contact's unified timeline.
            contact_id: this.form.lessorDetails.contact_id,
            lessor_name: this.form.lessorDetails.lessor_name,
            lessor_nationality: this.form.lessorDetails.lessor_nationality,
            lessor_address: this.form.lessorDetails.lessor_address,
          },
          lesseeData: {
            contact_id: this.form.lesseeDetails.contact_id,
            lessee_name: this.form.lesseeDetails.lessee_name,
            lessee_nationality: this.form.lesseeDetails.lessee_nationality || 'Filipino', // Default if not provided
            lessee_address: this.form.lesseeDetails.lessee_address,
            lessee_designation: this.form.lesseeDetails.lessee_designation,
            lessee_representative_name: this.form.lesseeDetails.lessee_representative_name,
            lessee_property_address: this.form.lesseeDetails.lessee_address, // Use same as lessee address
          },
          propertyData: {
            property_type: 'Commercial', // Default for commercial contract
            property_name: this.form.propertyDetails.property.building_name,
            property_area: this.form.propertyDetails.property_floor_area,
            propertyAddress: this.form.lesseeDetails.lessee_address, // Use lessee address as property address
            propertyParkingSpaces: '0', // Default value
            propertyCity: 'Manila', // Default city
            propertyManagerName: this.form.lessorDetails.lessor_name, // Use lessor as property manager
          },
          contractData: {
            lease_period: `${this.form.propertyDetails.lease_term} ${this.form.propertyDetails.lease_term_unit}`,
            lease_start_date: this.form.propertyDetails.lease_starting_date,
            freeRentPeriod: '0', // Default value
            freeRentStartDate: this.form.propertyDetails.lease_starting_date,
            leaseEndDate: this.form.propertyDetails.lease_starting_date, // Should calculate end date
            monthlyRent: this.form.propertyDetails.property_price,
            advanceRentPeriod: `${this.form.propertyDetails.advance} ${this.form.propertyDetails.advance_unit}`,
            signatureDate: new Date().toLocaleDateString(), // Current date
          },
          ownerData: {
            // Owner = lessor in this template; share the contact_id.
            contact_id: this.form.lessorDetails.contact_id,
            ownerName: this.form.lessorDetails.lessor_name, // Use lessor as owner
            ownerNationality: this.form.lessorDetails.lessor_nationality,
            ownerHomeAddress: this.form.lessorDetails.lessor_address,
          }
        }
        
        const response = await generateCommercialContractOfLeaseCall(transformedData)
        console.log('Document generated successfully:', response)

        dismissLoading()
        showToast({
          title: 'Commercial Contract of Lease generated successfully!',
          message: 'Document is downloading automatically. If download doesn\'t start, click the download link below.',
          icon: 'success',
        })
        
        // Add a download link as backup
        this.addDownloadLink(response)
        
        // Optionally redirect to documents page or show download link
        this.$router.push('/documents')
      } catch (error) {
        console.error('Error generating document:', error)
        dismissLoading()
        showToast({
          title: 'Failed to generate document',
          message: error.message || 'An error occurred while generating the document',
          icon: 'error',
        })
      }
    },
    save() {
      this.generateCommercialContractOfLease()
    },
  },
}
</script>
