<template>
  <!-- Gross Form -->
  <div class="tax-form pb-4">
    <form @submit.prevent="handleSubmit">
      <div class="form-group mb-4 flex items-center">
        <label class="w-1/5">Zonal Value Price</label>
        <input
          v-model="grossForm.zvp"
          type="text"
          class="w-3/5 p-2 border rounded"
        />
        <div class="w-1/5 p-2 rounded">
          {{ formattedZVP }}
        </div>
      </div>

      <div class="form-group mb-4 flex items-center">
        <label class="w-1/5">Nett To Owner</label>
        <input
          v-model="grossForm.nett_to_owner"
          type="text"
          class="w-3/5 p-2 border rounded"
        />
        <div class="w-1/5 p-2 rounded">
          {{ formattedNettToOwner }}
        </div>
      </div>

      <h3 class="text-lg font-bold">SELLER SIDE</h3>
      <div class="form-group mb-4 flex items-center">
        <label class="w-1/5">CAPITAL GAIN TAX (%)</label>
        <select
          v-model="grossForm.capital_gain_tax"
          class="w-3/5 p-2 border rounded"
        >
          <option value="2">2%</option>
          <option value="3">3%</option>
          <option value="5">5%</option>
        </select>
        <div class="w-1/5 p-2 rounded">
          {{ formattedGrossCapitalGainTax }}
        </div>
      </div>

      <div class="form-group mb-4 flex items-center">
        <label class="w-1/5">VALUE ADDED TAX (%)</label>
        <input
          v-model="grossForm.value_added_tax"
          type="text"
          class="w-3/5 p-2 border rounded"
        />
        <div class="w-1/5 p-2 rounded">
          {{ formattedGrossValueAddedTax }}
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">COMMISSION (%)</label>
          <input
            v-model="grossForm.commission"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossCommission }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 flex items-center">
          <label class="w-1/5 font-bold">GROSS PRICE</label>
          <div class="w-3/5 p-2"></div>
          <div class="w-1/5 p-2 rounded font-bold">
            {{ formattedGrossPrice }}
          </div>
        </div>
      </div>

      <h3 class="text-lg font-bold">BUYER's ACCOUNT</h3>
      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">DOCUMENTARY STAMP TAX (%)</label>
          <input
            v-model="grossForm.documentary_stamp_tax"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossDocumentaryStampTax }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">TRANSFER TAX (%)</label>
          <input
            v-model="grossForm.transfer_tax"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossTransferTax }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">REGISTRATION FEE (%)</label>
          <input
            v-model="grossForm.registration_fee"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossRegistrationFee }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">MISCELLANEOUS (%)</label>
          <input
            v-model="grossForm.misc_fee"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossMiscellaneous }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">PROCESSING FEE</label>
          <input
            v-model="grossForm.processing_fee"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossProcessingFee }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 flex items-center">
          <label class="w-1/5 font-bold">TOTAL BUYER ACCOUNT</label>
          <div class="w-3/5 p-2"></div>
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossBuyerAccount }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 flex items-center">
          <label class="w-1/5 font-bold">ALL IN COST</label>
          <div class="w-3/5 p-2"></div>
          <div class="w-1/5 p-2 rounded">
            {{ formattedGrossAllIn }}
          </div>
        </div>
      </div>

      <div class="mt-6">
        <button class="bg-primary text-white px-4 py-2 rounded">
          Generate Report
        </button>
      </div>
    </form>
  </div>
</template>

<script>
import { formatCurrency } from '~/helpers/helpers'
import { generateGrossTaxReport } from '~/services/tax-computations/grossReport'
import { showLoading, dismissLoading } from '~/helpers/helpers'
export default {
  name: 'GrossForm',
  data() {
    return {
      grossForm: {
        zvp: 0,
        nett_to_owner: 0,
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
  methods: {
    async handleSubmit() {
      showLoading()
      await generateGrossTaxReport(this.grossForm)
      dismissLoading()
    },
  },
  computed: {
    // Gross Form
    formattedZVP() {
      return formatCurrency(this.grossForm.zvp)
    },
    formattedNettToOwner() {
      return formatCurrency(this.grossForm.nett_to_owner)
    },
    // Calculate Gross Price using a formula that accounts for the higher value
    calculatedGrossPrice() {
      const nettToOwner = this.grossForm.nett_to_owner || 0
      const capitalGainTaxPercent = this.grossForm.capital_gain_tax || 0
      const valueAddedTaxPercent = this.grossForm.value_added_tax || 0
      const commissionPercent = this.grossForm.commission || 0
      const zvp = this.grossForm.zvp || 0

      // Calculate taxes based on zonal value
      const capitalGainTax = (capitalGainTaxPercent / 100) * zvp
      const valueAddedTax = (valueAddedTaxPercent / 100) * zvp
      const commission = (commissionPercent / 100) * zvp

      console.log('nettToOwner: ', nettToOwner)
      console.log('capitalGainTax: ', capitalGainTax)
      console.log('valueAddedTax: ', valueAddedTax)
      console.log('commission: ', commission)

      // Gross price is nett to owner plus taxes
      const grossPrice =
        Number(nettToOwner) +
        Number(capitalGainTax) +
        Number(valueAddedTax) +
        Number(commission)

      console.log('grossPrice: ', grossPrice)

      return grossPrice
    },
    formattedGrossPrice() {
      return formatCurrency(this.calculatedGrossPrice)
    },
    formattedGrossCapitalGainTax() {
      const capitalGainTax =
        (this.grossForm.capital_gain_tax / 100) * this.grossForm.zvp
      return formatCurrency(capitalGainTax)
    },
    formattedGrossValueAddedTax() {
      const valueAddedTax =
        (this.grossForm.value_added_tax / 100) * this.grossForm.zvp
      return formatCurrency(valueAddedTax)
    },
    formattedGrossCommission() {
      const commission = (this.grossForm.commission / 100) * this.grossForm.zvp
      return formatCurrency(commission)
    },
    formattedGrossSellerSideTotal() {
      const sellerSideTotal =
        (this.grossForm.capital_gain_tax / 100) * this.grossForm.zvp +
        (this.grossForm.value_added_tax / 100) * this.grossForm.zvp +
        (this.grossForm.commission / 100) * this.grossForm.zvp
      return formatCurrency(sellerSideTotal)
    },
    formattedTotalSellerNett() {
      const totalSellerGross =
        (this.grossForm.capital_gain_tax / 100) * this.grossForm.zvp +
        (this.grossForm.value_added_tax / 100) * this.grossForm.zvp +
        (this.grossForm.commission / 100) * this.grossForm.zvp
      const totalSellerNett = this.calculatedGrossPrice - totalSellerGross
      return formatCurrency(totalSellerNett)
    },
    formattedGrossDocumentaryStampTax() {
      const documentaryStampTax =
        (this.grossForm.documentary_stamp_tax / 100) * this.grossForm.zvp
      return formatCurrency(documentaryStampTax)
    },
    formattedGrossTransferTax() {
      const transferTax =
        (this.grossForm.transfer_tax / 100) * this.grossForm.zvp
      return formatCurrency(transferTax)
    },
    formattedGrossRegistrationFee() {
      const registrationFee =
        (this.grossForm.registration_fee / 100) * this.grossForm.zvp
      return formatCurrency(registrationFee)
    },
    formattedGrossMiscellaneous() {
      const miscellaneous = (this.grossForm.misc_fee / 100) * this.grossForm.zvp
      return formatCurrency(miscellaneous)
    },
    formattedGrossProcessingFee() {
      return formatCurrency(this.grossForm.processing_fee)
    },
    formattedGrossBuyerAccount() {
      const buyerAccount =
        (this.grossForm.documentary_stamp_tax / 100) *
          this.calculatedGrossPrice +
        (this.grossForm.transfer_tax / 100) * this.grossForm.zvp +
        (this.grossForm.registration_fee / 100) * this.grossForm.zvp +
        (this.grossForm.misc_fee / 100) * this.grossForm.zvp +
        this.grossForm.processing_fee
      return formatCurrency(buyerAccount)
    },
    formattedGrossAllIn() {
      const grossBuyerAccount =
        (this.grossForm.documentary_stamp_tax / 100) *
          this.calculatedGrossPrice +
        (this.grossForm.transfer_tax / 100) * this.calculatedGrossPrice +
        (this.grossForm.registration_fee / 100) * this.calculatedGrossPrice +
        (this.grossForm.misc_fee / 100) * this.calculatedGrossPrice +
        this.grossForm.processing_fee
      const allIn = this.calculatedGrossPrice + grossBuyerAccount
      return formatCurrency(allIn)
    },
  },
}
</script>
