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
        <div class="mb-2">
          <VSelect
            required
            id="property_id"
            :model-value="form.propertyDetails.property?.id"
            @option:selected="onPropertySelect"
            placeholder="Select property"
            :error="errors.property_id"
            :options="availableProperties"
            >Property</VSelect
          >
        </div>

        <!-- Building Name -->
        <div class="mb-2">
          <Input
            id="name"
            type="text"
            :model-value="form.propertyDetails.property.building_name"
            @change="
              (value) => (form.propertyDetails.property.building_name = value)
            "
            required
            :error="errors.building_name"
            >Building Name</Input
          >
        </div>

        <!-- Price -->
        <div class="mb-2">
          <Input
            id="price"
            placeholder="0.00"
            type="text"
            :model-value="formatPrice(form.propertyDetails.property_price)"
            @change="(value) => (form.propertyDetails.property_price = value)"
            required
            :error="errors.property_price"
            >Price</Input
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
            :error="errors.lease_starting_date"
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
            >Minimum Lease Term <span class="text-red">*</span></label
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
                :error="errors.lease_term"
                error-message-invisible
              />
            </div>
            <div class="w-1/2 ml-1">
              <VSelect
                v-model="form.propertyDetails.lease_term_unit"
                placeholder="Select unit"
                :clearable="false"
                :error="errors.lease_term_unit"
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
                :error="errors.advance"
                error-message-invisible
              />
            </div>
            <div class="w-1/2 ml-1">
              <VSelect
                v-model="form.propertyDetails.advance_unit"
                placeholder="Select unit"
                :clearable="false"
                :error="errors.advance_unit"
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
                :error="errors.deposit"
                error-message-invisible
              />
            </div>
            <div class="w-1/2 ml-1">
              <VSelect
                v-model="form.propertyDetails.deposit_unit"
                placeholder="Select unit"
                :clearable="false"
                :error="errors.deposit_unit"
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

      <div class="grid w-full grid-cols-2 gap-4 mb-4">
        <!-- Name -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <Input
            id="lessor_name"
            type="text"
            :model-value="form.lessorDetails.lessor_name"
            @change="(value) => (form.lessorDetails.lessor_name = value)"
            required
            :error="errors.lessor_name"
            >Full Name</Input
          >
        </div>

        <!-- Gender -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <label class="mb-2 text-sm font-bold text-foreground"
            >Gender <span class="text-red">*</span></label
          >
          <div class="flex h-10 w-full">
            <VSelect
              v-model="form.lessorDetails.lessor_gender"
              :clearable="false"
              placeholder="Select gender"
              required
              :error="errors.lessor_gender"
              :options="genders"
              label="text"
            />
          </div>
        </div>

        <!-- Nationality -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <Input
            id="lessor_nationality"
            placeholder="Enter nationality"
            type="text"
            :model-value="form.lessorDetails.lessor_nationality"
            @change="(value) => (form.lessorDetails.lessor_nationality = value)"
            required
            :error="errors.lessor_nationality"
            >Nationality</Input
          >
        </div>

        <!-- Civil Status -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <Input
            id="lessor_civil_status"
            placeholder="Enter civil status"
            type="text"
            :model-value="form.lessorDetails.lessor_civil_status"
            @change="
              (value) => (form.lessorDetails.lessor_civil_status = value)
            "
            required
            :error="errors.lessor_civil_status"
            >Civil Status</Input
          >
        </div>

        <!-- Address -->
        <div class="col-span-2 mb-2">
          <Input
            id="lessor_address"
            type="text"
            :model-value="form.lessorDetails.lessor_address"
            @change="(value) => (form.lessorDetails.lessor_address = value)"
            required
            :error="errors.lessor_address"
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

      <div class="grid w-full md:grid-cols-2 gap-4 mb-4">
        <!-- Name -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <Input
            id="lessee_name"
            type="text"
            :model-value="form.lesseeDetails.lessee_name"
            @change="(value) => (form.lesseeDetails.lessee_name = value)"
            required
            :error="errors.lessee_name"
            placeholder="Enter lessee name"
            >Full Name</Input
          >
        </div>

        <!-- Gender -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <label class="mb-2 text-sm font-bold text-foreground"
            >Gender <span class="text-red">*</span></label
          >
          <div class="flex h-10">
            <VSelect
              v-model="form.lesseeDetails.lessee_gender"
              :clearable="false"
              placeholder="Select gender"
              required
              :error="errors.lessee_gender"
              :options="genders"
              label="text"
            />
          </div>
        </div>

        <!-- Nationality -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <Input
            id="lessee_nationality"
            type="text"
            :model-value="form.lesseeDetails.lessee_nationality"
            @change="(value) => (form.lesseeDetails.lessee_nationality = value)"
            required
            :error="errors.lessee_nationality"
            placeholder="Enter nationality"
            >Nationality</Input
          >
        </div>

        <!-- Civil Status -->
        <div class="col-span-2 sm:col-span-1 mb-2">
          <Input
            id="lessee_civil_status"
            type="text"
            :model-value="form.lesseeDetails.lessee_civil_status"
            @change="
              (value) => (form.lesseeDetails.lessee_civil_status = value)
            "
            required
            :error="errors.lessee_civil_status"
            placeholder="Enter civil status"
            >Civil Status</Input
          >
        </div>

        <!-- Address -->
        <div class="col-span-2 mb-2">
          <Input
            id="lessee_address"
            type="text"
            :model-value="form.lesseeDetails.lessee_address"
            @change="(value) => (form.lesseeDetails.lessee_address = value)"
            required
            :error="errors.lessee_address"
            >Address</Input
          >
        </div>
      </div>
    </div>

    <div class="flex flex-col md:flex-row mt-auto gap-5">
      <button
        type="button"
        class="md:mr-auto rounded-lg w-full sm:w-39 h-9 bg-green bg-opacity-20 hover:bg-green-dark hover:bg-opacity-30"
        @click="previousStep"
        v-show="step > 1"
      >
        <span class="inline-block text-green font-bold mt-0.5">Previous</span>
      </button>
      <button
        type="button"
        class="md:ml-auto rounded-lg w-full sm:w-39 h-9 bg-green bg-opacity-20 hover:bg-green-dark hover:bg-opacity-30"
        @click="nextStep"
        v-show="step < 3"
      >
        <span class="inline-block text-green font-bold mt-0.5">Next</span>
      </button>
      <button
        type="button"
        class="ml-auto rounded-lg w-full sm:w-39 h-9 bg-green"
        @click="save"
        v-show="step === 3"
      >
        <span class="inline-block text-white font-bold mt-0.5">Generate</span>
      </button>
    </div>
  </section>
</template>

<script>
import properties from '~/mixins/domains/properties'
import HelperText from '~/components/HelperText'
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import ContactPicker from '~/components/contacts/ContactPicker.vue'
import { generateResidentialContractOfLeaseCall } from '~/services/document.services'
import { showToast, showLoading, dismissLoading } from '~/helpers/helpers'

export default {
  mixins: [properties],
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
      availableProperties: [],
      form: {
        propertyDetails: {
          property: {
            id: '',
            title: '',
            building_name: '',
            city: '',
          },
          property_price: '',
          lease_starting_date: '',
          lease_term: '',
          lease_term_unit: '',
          advance: '',
          advance_unit: '',
          deposit: '',
          deposit_unit: '',
          name: '', // Property name for template
          city: '', // Property city for template
          price: '', // Property price for template
        },
        lessorDetails: {
          // Cross-entity link to a contact — surfaces document on the
          // contact's unified timeline.
          contact_id: null,
          selectedContact: null,
          lessor_name: '',
          lessor_gender: '',
          lessor_nationality: '',
          lessor_civil_status: '',
          lessor_address: '',
        },
        lesseeDetails: {
          contact_id: null,
          selectedContact: null,
          lessee_name: '',
          lessee_gender: '',
          lessee_nationality: '',
          lessee_civil_status: '',
          lessee_address: '',
        },
        contractData: {
          contractDay: '',
          contractMonth: '',
          contractYear: '',
          contractCity: '',
          leaseEndDate: '',
          renewalNoticePeriod: '',
          rentalPaymentDate: '',
          securityDepositReturnPeriod: '',
          postDatedCheques: '',
          totalPayment: '',
          utilities: '',
          majorRepairExpenditure: '',
          minorRepairExpenditure: '',
          attorneyFees: '',
          attorneyFeesMinimum: '',
        },
      },
      errors: {},
      step: 1,
    }
  },
  async mounted() {
    const { data: listingDetails, error: listingDetailsError } =
      await useSupabaseClient()
        // Reads from `listing_details` (canonical wide read source —
        // exposes city_name natively via the join).
        .from('listing_details')
        .select('listing_id, title, property_name, city_name')
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
      city: listing.city_name,
    }))

    // Populate default contract data
    this.populateContractData()
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
    
    // Populate contract data with current date and defaults
    populateContractData() {
      const now = new Date()
      this.form.contractData.contractDay = now.getDate().toString()
      this.form.contractData.contractMonth = (now.getMonth() + 1).toString()
      this.form.contractData.contractYear = now.getFullYear().toString()
      this.form.contractData.contractCity = 'Manila' // Default city
      this.form.contractData.leaseEndDate = this.form.propertyDetails.lease_starting_date || ''
      this.form.contractData.renewalNoticePeriod = '30 days'
      this.form.contractData.rentalPaymentDate = '5th day of each month'
      this.form.contractData.securityDepositReturnPeriod = '30 days after lease termination'
      this.form.contractData.postDatedCheques = 'Yes'
      this.form.contractData.totalPayment = this.form.propertyDetails.property_price || '0'
      this.form.contractData.utilities = 'Tenant pays for utilities'
      this.form.contractData.majorRepairExpenditure = 'Landlord responsible for major repairs'
      this.form.contractData.minorRepairExpenditure = 'Tenant responsible for minor repairs'
      this.form.contractData.attorneyFees = 'Each party pays their own attorney fees'
      this.form.contractData.attorneyFeesMinimum = '0'
    },
    
    // Handle property selection (option from NewVSelect has id, label, text, property_name, city)
    onPropertySelect(property) {
      if (property) {
        this.form.propertyDetails.property = {
          id: property.id,
          title: property.text || property.label,
          building_name: property.property_name || '',
          city: property.city || 'Manila',
        }
        this.form.propertyDetails.name = this.form.propertyDetails.property.building_name || this.form.propertyDetails.property.title
        this.form.propertyDetails.city = this.form.propertyDetails.property.city
        this.form.propertyDetails.price = this.form.propertyDetails.property_price || '0'
        this.populateContractData()
      }
    },
    
    // Handle property search/fetch
    onFetchProperties(query) {
      // This method is called when searching properties
      // The VSelect component handles the filtering automatically
      return this.availableProperties
    },
    
    // Handle property change (alternative method name)
    onPropertyChanged(property) {
      // Call the same method as onPropertySelect for consistency
      this.onPropertySelect(property)
    },
    
    nextStep() {
      this.step++
    },
    previousStep() {
      this.step--
    },
    
    // Add download link as backup
    addDownloadLink(fileUrl) {
      // Create a download link element
      const downloadDiv = document.createElement('div')
      downloadDiv.className = 'fixed top-4 right-4 bg-success text-success-foreground p-4 rounded-lg shadow-lg z-50'
      downloadDiv.innerHTML = `
        <div class="flex items-center space-x-2">
          <span>📄 Document Ready!</span>
          <a href="${fileUrl}" download="Residential_Contract_of_Lease.docx"
             class="bg-card text-success px-3 py-1 rounded hover:bg-muted">
            Download
          </a>
          <button onclick="this.parentElement.parentElement.remove()"
                  class="text-success-foreground hover:text-foreground ml-2">×</button>
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
    
    save() {
      // Validate required fields first
      if (!this.form.propertyDetails.property.id) {
        showToast({
          title: 'Validation Error',
          message: 'Please select a property',
          icon: 'error',
        })
        return
      }
      
      if (!this.form.lessorDetails.lessor_name || !this.form.lesseeDetails.lessee_name) {
        showToast({
          title: 'Validation Error',
          message: 'Please fill in all required fields (lessor and lessee names)',
          icon: 'error',
        })
        return
      }
      
      // Ensure contract data is populated
      if (!this.form.contractData.contractDay || !this.form.contractData.contractMonth || !this.form.contractData.contractYear) {
        this.populateContractData()
      }
      
      // Ensure property details are properly set
      if (!this.form.propertyDetails.name) {
        this.form.propertyDetails.name = this.form.propertyDetails.property.property_name || this.form.propertyDetails.property.title
      }
      if (!this.form.propertyDetails.city) {
        this.form.propertyDetails.city = this.form.propertyDetails.property.city || 'Manila'
      }
      if (!this.form.propertyDetails.price) {
        this.form.propertyDetails.price = this.form.propertyDetails.property_price || '0'
      }

      showLoading()
      generateResidentialContractOfLeaseCall(this.form)
        .then((response) => {
          dismissLoading()
          showToast({
            title: 'Residential Contract of Lease generated successfully!',
            message: 'Document is downloading automatically. If download doesn\'t start, click the download link below.',
            icon: 'success',
          })
          
          // Add a download link as backup
          this.addDownloadLink(response)
          
          // Optionally redirect to documents page
          this.$router.push('/documents')
        })
        .catch((error) => {
          console.error('Error generating document:', error)
          console.error('Error details:', {
            name: error.name,
            message: error.message,
            stack: error.stack
          })
          dismissLoading()
          showToast({
            title: 'Failed to generate document',
            message: error.message || 'An error occurred while generating the document',
            icon: 'error',
          })
        })
    },
  },
}
</script>
