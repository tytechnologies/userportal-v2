<template>
  <div class="tax-computation lg:px-[10%] mb-4">
    <!-- Main Navigation Tabs -->
    <nav class="flex mb-4 border-b h-14 border-border">
      <button
        v-for="(tab, index) in mainTabs"
        :key="index"
        type="button"
        @click="toggleMainTab(index)"
        :class="[
          'mr-8 text-xs font-bold sm:text-sm md:text-sm lg:text-sm h-14',
          { 'pt-0.5 border-b-2 border-blue': activeMainTab === index },
        ]"
      >
        {{ tab.title }}
      </button>
    </nav>

    <!-- Individual Tax Section -->
    <div v-if="activeMainTab === 0" class="tax-section">
      <!-- Individual Sub Tabs -->
      <div class="sub-tabs flex border-b mb-4">
        <button
          v-for="(tab, index) in individualTabs"
          :key="index"
          @click="toggleSubTab(index)"
          :class="[
            'px-4 py-2 mr-2',
            { 'border-b-2 border-blue': activeSubTab === index },
          ]"
        >
          {{ tab.title }}
        </button>
      </div>

      <!-- Individual Tax Forms -->
      <div class="tax-forms overflow-y-auto max-h-[calc(100vh-20rem)]">
        <!-- Nett/ZV Form -->
        <div v-if="activeSubTab === 0" class="tax-form pb-4">
          <form @submit.prevent="handleSubmit">
            <span class="text-lg font-bold">Unit ZV</span>
            <div class="form-group mb-4 flex items-center">
              <label class="w-1/5">Zonal Value Price</label>
              <input
                v-model="form.zvp"
                type="text"
                class="w-3/5 p-2 border rounded"
              />
              <div class="w-1/5 p-2 rounded">
                {{ formattedZVP }}
              </div>
            </div>

            <div class="form-group mb-4 flex items-center">
              <label class="w-1/5">Gross Price</label>
              <input
                v-model="form.gross_price"
                type="text"
                class="w-3/5 p-2 border rounded"
              />
              <div class="w-1/5 p-2 rounded">
                {{ formattedGrossPrice }}
              </div>
            </div>

            <div class="form-group mb-4 flex items-center">
              <label class="w-1/5">Higher Value (ZVP or Gross)</label>
              <div class="w-3/5 p-2"></div>
              <div class="w-1/5 p-2 rounded font-bold">
                {{ formattedHigherValue }}
              </div>
            </div>

            <h3 class="text-lg font-bold">SELLER SIDE</h3>
            <div class="form-group mb-4 flex items-center">
              <label class="w-1/5">CAPITAL GAIN TAX (%)</label>
              <select
                v-model="form.capital_gain_tax"
                class="w-3/5 p-2 border rounded"
              >
                <option value="2">2%</option>
                <option value="3">3%</option>
                <option value="5">5%</option>
              </select>
              <div class="w-1/5 p-2 rounded">
                {{ formattedCapitalGainTax }}
              </div>
            </div>

            <div class="form-group mb-4 flex items-center">
              <label class="w-1/5">VALUE ADDED TAX (%)</label>
              <input
                v-model="form.value_added_tax"
                type="text"
                class="w-3/5 p-2 border rounded"
              />
              <div class="w-1/5 p-2 rounded">
                {{ formattedValueAddedTax }}
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
                <label class="w-1/5">COMMISSION (%)</label>
                <input
                  v-model="form.commission"
                  type="text"
                  class="w-3/5 p-2 border rounded"
                />
                <div class="w-1/5 p-2 rounded">
                  {{ formattedCommission }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 flex items-center">
                <label class="w-1/5 font-bold">NETT TO OWNER</label>
                <div class="w-3/5 p-2"></div>
                <div class="w-1/5 p-2 rounded font-bold">
                  {{ formattedNettToOwner }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 flex items-center">
                <label class="w-1/5 font-bold">TOTAL SELLER</label>
                <div class="w-3/5 p-2"></div>
                <div class="w-1/5 p-2 rounded">
                  {{ totalSeller }}
                </div>
              </div>
            </div>

            <h3 class="text-lg font-bold">BUYER SIDE</h3>
            <div class="summary mt-6">
              <div class="form-group mb-4 lg:flex-row flex flex-col items-start lg:items-center">
                <label class="lg:w-1/5">DOCUMENTARY STAMP TAX (%)</label>
                <input
                  v-model="form.documentary_stamp_tax"
                  type="text"
                  class="w-3/5 p-2 border rounded"
                />
                <div class="lg:w-1/5 p-2 rounded">
                  {{ formattedDocumentaryStampTax }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 lg:flex-row flex flex-col items-start lg:items-center">
                <label class="lg:w-1/5">TRANSFER TAX (%)</label>
                <input
                  v-model="form.transfer_tax"
                  type="text"
                  class="w-3/5 p-2 border rounded"
                />
                <div class="lg:w-1/5 p-2 rounded">
                  {{ formattedTransferTax }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 lg:flex-row flex flex-col items-start lg:items-center">
                <label class="lg:w-1/5">REGISTRATION FEE (%)</label>
                <input
                  v-model="form.registration_fee"
                  type="text"
                  class="w-3/5 p-2 border rounded"
                />
                <div class="lg:w-1/5 p-2 rounded">
                  {{ formattedRegistrationFee }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 lg:flex-row flex flex-col items-start lg:items-center">
                <label class="lg:w-1/5">MISCELLANEOUS (%)</label>
                <input
                  v-model="form.misc_fee"
                  type="text"
                  class="w-3/5 p-2 border rounded"
                />
                <div class="lg:w-1/5 p-2 rounded">
                  {{ formattedMiscellaneous }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 lg:flex-row flex flex-col items-start lg:items-center">
                <label class="lg:w-1/5">PROCESSING FEE</label>
                <input
                  v-model="form.processing_fee"
                  type="text"
                  class="w-3/5 p-2 border rounded"
                />
                <div class="lg:w-1/5 p-2 rounded">
                  {{ formattedProcessingFee }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 flex items-center">
                <label class="w-1/5 font-bold">BUYER's ACCOUNT</label>
                <div class="w-3/5 p-2"></div>
                <div class="w-1/5 p-2 rounded">
                  {{ formattedBuyerAccount }}
                </div>
              </div>
            </div>

            <div class="summary mt-6">
              <div class="form-group mb-4 flex items-center">
                <label class="w-1/5 font-bold">ALL IN</label>
                <div class="w-3/5 p-2"></div>
                <div class="w-1/5 p-2 rounded">
                  {{ formattedAllIn }}
                </div>
              </div>
            </div>

            <div class="mt-6 flex gap-2">
              <button
                type="button"
                class="bg-primary text-white px-4 py-2 rounded"
              >
                Generate Report
              </button>
              <button
                type="button"
                class="border border-primary text-primary px-4 py-2 rounded transition-colors duration-150 ease-out hover:bg-primary/10 focus-ring disabled:opacity-50"
                :disabled="isSavingRecord"
                @click="saveTaxRecord"
              >
                {{ isSavingRecord ? 'Saving…' : 'Save record' }}
              </button>
            </div>
          </form>
        </div>

        <GrossForm v-if="activeSubTab === 1" />
      </div>
    </div>

    <!-- Corporate Tax Section -->
    <div v-if="activeMainTab === 1" class="tax-section">
      <!-- Corporate Sub Tabs -->
      <div class="sub-tabs flex border-b mb-4">
        <button
          v-for="(tab, index) in corporateTabs"
          :key="index"
          @click="toggleCorporateSubTab(index)"
          :class="[
            'px-4 py-2 mr-2',
            { 'border-b-2 border-blue': activeCorporateSubTab === index },
          ]"
        >
          {{ tab.title }}
        </button>
      </div>

      <!-- Corporate Tax Forms -->
      <div class="tax-forms overflow-y-auto max-h-[calc(100vh-20rem)]">
        <CorporateNettOnZV v-if="activeCorporateSubTab === 0" />
        <CorporateGrossForm v-if="activeCorporateSubTab === 1" />
      </div>
    </div>
  </div>
</template>

<script>
// Fix the imports to use the proper URL format
import { showLoading, dismissLoading, formatCurrency } from '@/helpers/helpers'
import GrossForm from '@/components/tax-computations/GrossForm.vue'
import { generateNettZVTaxReport } from '@/services/tax-computations/nettzvReport'
import CorporateGrossForm from '@/components/tax-computations/CorporateGrossForm.vue'
import CorporateNettOnZV from '@/components/tax-computations/CorporateNettOnZV.vue'

export default {
  components: {
    GrossForm,
    CorporateGrossForm,
    CorporateNettOnZV,
  },
  mounted() {
    // ?record=<uuid> on the documents-legacy route hydrates the form
    // from a saved tax_computations row. Route the loader off to a
    // method so the imports stay lazy (composable + helpers).
    const recordId = this.$route?.query?.record
    if (typeof recordId === 'string' && recordId.length > 0) {
      this.loadFromRecord(recordId)
    }
  },

  data() {
    return {
      isSavingRecord: false,
      activeMainTab: 1,
      mainTabs: [
        { title: 'Individual', key: 'individual' },
        { title: 'Corporate', key: 'corporate' },
      ],
      activeSubTab: 0,
      activeCorporateSubTab: 0,
      individualTabs: [
        { title: 'Nett/ZV', key: 'nett-zv' },
        { title: 'Gross', key: 'gross' },
      ],
      corporateTabs: [
        { title: 'Nett/ZV', key: 'nett-zv' },
        { title: 'Gross', key: 'gross' },
      ],
      form: {
        zvp: 0,
        gross_price: 0,
        capital_gain_tax: 2,
        value_added_tax: 0,
        commission: 0,
        documentary_stamp_tax: 0,
        transfer_tax: 0,
        registration_fee: 0,
        misc_fee: 0,
        processing_fee: 45000,
      },
    }
  },

  computed: {
    formattedZVP() {
      return formatCurrency(this.form.zvp)
    },
    formattedGrossPrice() {
      return formatCurrency(this.form.gross_price)
    },
    formattedHigherValue() {
      return formatCurrency(this.higherValue)
    },
    higherValue() {
      return Math.max(this.form.zvp || 0, this.form.gross_price || 0)
    },
    formattedCapitalGainTax() {
      const capitalGainTax =
        (this.form.capital_gain_tax / 100) * this.higherValue
      return formatCurrency(capitalGainTax)
    },
    formattedValueAddedTax() {
      const valueAddedTax = (this.form.value_added_tax / 100) * this.higherValue
      return formatCurrency(valueAddedTax)
    },
    formattedCommission() {
      const commission = (this.form.commission / 100) * this.higherValue
      return formatCurrency(commission)
    },
    formattedNettToOwner() {
      const capitalGainTax =
        (this.form.capital_gain_tax / 100) * this.higherValue
      const valueAddedTax = (this.form.value_added_tax / 100) * this.higherValue
      const commission = (this.form.commission / 100) * this.higherValue
      const nettToOwner =
        this.form.gross_price - capitalGainTax - valueAddedTax - commission
      return formatCurrency(nettToOwner)
    },
    totalSeller() {
      const totalGrossWithCommission =
        (this.form.capital_gain_tax / 100) * this.higherValue +
        (this.form.value_added_tax / 100) * this.higherValue +
        (this.form.commission / 100) * this.higherValue
      return formatCurrency(totalGrossWithCommission)
    },
    formattedDocumentaryStampTax() {
      const documentaryStampTax =
        (this.form.documentary_stamp_tax / 100) * this.higherValue
      return formatCurrency(documentaryStampTax)
    },
    formattedTransferTax() {
      const transferTax = (this.form.transfer_tax / 100) * this.higherValue
      return formatCurrency(transferTax)
    },
    formattedRegistrationFee() {
      const registrationFee =
        (this.form.registration_fee / 100) * this.higherValue
      return formatCurrency(registrationFee)
    },
    formattedMiscellaneous() {
      const miscellaneous = (this.form.misc_fee / 100) * this.higherValue
      return formatCurrency(miscellaneous)
    },
    formattedProcessingFee() {
      return formatCurrency(this.form.processing_fee)
    },
    formattedBuyerAccount() {
      const buyerAccount =
        (this.form.documentary_stamp_tax / 100) * this.higherValue +
        (this.form.transfer_tax / 100) * this.higherValue +
        (this.form.registration_fee / 100) * this.higherValue +
        (this.form.misc_fee / 100) * this.higherValue +
        this.form.processing_fee
      return formatCurrency(buyerAccount)
    },
    formattedAllIn() {
      const allIn =
        (this.form.documentary_stamp_tax / 100) * this.higherValue +
        (this.form.transfer_tax / 100) * this.higherValue +
        (this.form.registration_fee / 100) * this.higherValue +
        (this.form.misc_fee / 100) * this.higherValue +
        this.form.processing_fee
      return formatCurrency(allIn + this.form.gross_price)
    },
  },
  methods: {
    toggleMainTab(index) {
      if (this.activeMainTab === index) return
      this.activeMainTab = index
      this.activeSubTab = 0
    },

    toggleSubTab(index) {
      if (this.activeSubTab === index) return
      this.activeSubTab = index
    },

    toggleCorporateSubTab(index) {
      if (this.activeCorporateSubTab === index) return
      this.activeCorporateSubTab = index
    },

    async handleSubmit() {
      showLoading()
      await generateNettZVTaxReport(this.form)
      dismissLoading()
    },

    /**
     * Hydrate the form from a saved tax_computations record. Called on
     * mount when the URL carries `?record=<uuid>`. Switches to the
     * Individual Nett/ZV tab (the only sub-form this component owns
     * directly) and copies the saved inputs over `this.form`.
     *
     * Records saved from other variants (Gross, Corporate) won't load
     * here cleanly — their input shapes differ. Show a toast and let
     * the user navigate to the right tab manually.
     */
    async loadFromRecord(recordId) {
      try {
        const { useTaxComputations } = await import('~/composables/useTaxComputations')
        const { showToast } = await import('@/helpers/helpers')
        const { getTaxComputation } = useTaxComputations()
        const record = await getTaxComputation(recordId)

        // Only the Individual Nett/ZV variant matches this component's
        // form shape. Surface a hint when the user lands here with a
        // record from a different variant.
        if (record.taxpayer_type !== 'individual' || record.computation_kind !== 'nett_zv') {
          showToast({
            title: `This record was saved from "${record.taxpayer_type} ${record.computation_kind}". Switch to that tab to edit it.`,
            icon: 'warning',
          })
        }

        // Copy known input fields onto this.form. Unknown keys land
        // unchanged (form keeps its defaults).
        const inputs = record.inputs || {}
        for (const key of Object.keys(this.form)) {
          if (key in inputs) this.form[key] = inputs[key]
        }

        // Force the user onto the matching tab so what they see lines
        // up with the data we just loaded.
        if (record.taxpayer_type === 'individual') {
          this.activeMainTab = 0
          this.activeSubTab = record.computation_kind === 'gross' ? 1 : 0
        } else {
          this.activeMainTab = 1
          this.activeCorporateSubTab = record.computation_kind === 'gross' ? 1 : 0
        }

        showToast({ title: 'Loaded saved record.', icon: 'success' })
      } catch (err) {
        const { showToast } = await import('@/helpers/helpers')
        showToast({
          title: err?.statusMessage || err?.message || 'Could not load record',
          icon: 'error',
        })
      }
    },

    /**
     * Persist the current Individual Nett/ZV form state as a tax_computations
     * record. Other tabs (Gross, Corporate variants) live in sub-components
     * with their own state — they'll get the same retrofit when visited.
     *
     * Pre-link to a contact / listing is captured via two simple prompts so
     * the record surfaces on those entities' Documents panels. Bypass with
     * a blank input to skip.
     */
    async saveTaxRecord() {
      if (this.isSavingRecord) return
      const { showToast } = await import('@/helpers/helpers')

      const defaultTitle = `Individual Nett/ZV · ₱${Number(this.form.gross_price || this.form.zvp || 0).toLocaleString()}`
      const title = window.prompt('Title for this record (optional)', defaultTitle)
      if (title === null) return // cancelled

      const contactRaw = window.prompt('Linked contact ID (optional, blank to skip)', '')
      if (contactRaw === null) return
      const listingRaw = window.prompt('Linked listing ID (optional, blank to skip)', '')
      if (listingRaw === null) return

      const contactId = contactRaw.trim() ? Number(contactRaw.trim()) : null
      const listingId = listingRaw.trim() ? Number(listingRaw.trim()) : null
      if (contactRaw.trim() && !Number.isFinite(contactId)) {
        showToast({ title: 'Contact ID must be a number.', icon: 'error' })
        return
      }
      if (listingRaw.trim() && !Number.isFinite(listingId)) {
        showToast({ title: 'Listing ID must be a number.', icon: 'error' })
        return
      }

      this.isSavingRecord = true
      try {
        const { useTaxComputations } = await import('~/composables/useTaxComputations')
        const { createTaxComputation } = useTaxComputations()
        await createTaxComputation({
          taxpayer_type: 'individual',
          computation_kind: 'nett_zv',
          inputs: { ...this.form },
          title: title.trim() || null,
          contact_id: contactId,
          listing_id: listingId,
        })
        showToast({ title: 'Tax computation saved.', icon: 'success' })
      } catch (err) {
        showToast({
          title: err?.statusMessage || err?.message || 'Failed to save record',
          icon: 'error',
        })
      } finally {
        this.isSavingRecord = false
      }
    },
  },
}
</script>

<style scoped>
.tax-computation-form label {
  padding-top: 3px;
}

.percent-suffix {
  width: 70px;
  margin-left: 0.5rem;
  padding-top: 7px;
}

.btn-save-width {
  width: 11rem;
}
</style>
