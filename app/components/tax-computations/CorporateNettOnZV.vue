<template>
  <!-- Nett/ZV Form -->
  <div class="tax-form pb-4">
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
      <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
        <label class="w-1/5">WITHHOLDING TAX (%)</label> 
        <select v-model="form.withholding_tax" class="w-3/5 p-2 border rounded">
          <option value="6">6%</option>
        </select>
        <div class="w-1/5 p-2 rounded">
          {{ formattedWithholdingTax }}
        </div>
      </div>

      <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
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
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5 font-bold">NETT TO OWNER</label>
          <div class="w-3/5 p-2"></div>
          <div class="w-1/5 p-2 rounded font-bold">
            {{ formattedNettToOwner }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5 font-bold">TOTAL SELLER</label>
          <div class="w-3/5 p-2"></div>
          <div class="w-1/5 p-2 rounded">
            {{ totalSeller }}
          </div>
        </div>
      </div>

      <h3 class="text-lg font-bold">BUYER SIDE</h3>
      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">DOCUMENTARY STAMP TAX (%)</label>
          <input
            v-model="form.documentary_stamp_tax"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedDocumentaryStampTax }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">TRANSFER TAX (%)</label>
          <input
            v-model="form.transfer_tax"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedTransferTax }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">REGISTRATION FEE (%)</label>
          <input
            v-model="form.registration_fee"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedRegistrationFee }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">MISCELLANEOUS (%)</label>
          <input
            v-model="form.misc_fee"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
            {{ formattedMiscellaneous }}
          </div>
        </div>
      </div>

      <div class="summary mt-6">
        <div class="form-group mb-4 md:flex md:flex-row flex flex-col items-start lg:items-center">
          <label class="w-1/5">PROCESSING FEE</label>
          <input
            v-model="form.processing_fee"
            type="text"
            class="w-3/5 p-2 border rounded"
          />
          <div class="w-1/5 p-2 rounded">
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
import { generateNettZVTaxReport } from '~/services/tax-computations/nettzvReport'
import { showLoading, dismissLoading } from '~/helpers/helpers'
export default {
  name: 'CorporateNettOnZV',
  data() {
    return {
      form: {
        zvp: 0,
        gross_price: 0,
        withholding_tax: 6,
        value_added_tax: 12,
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
      await generateNettZVTaxReport(this.form)
      dismissLoading()
    },
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
    formattedWithholdingTax() {
      const withholdingTax =
        (this.form.withholding_tax / 100) * this.higherValue
      return formatCurrency(withholdingTax)
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
      const withholdingTax =
        (this.form.withholding_tax / 100) * this.higherValue
      const valueAddedTax = (this.form.value_added_tax / 100) * this.higherValue
      const commission = (this.form.commission / 100) * this.higherValue
      const nettToOwner =
        this.higherValue - withholdingTax - valueAddedTax - commission
      return formatCurrency(nettToOwner)
    },
    totalSeller() {
      const totalGrossWithCommission =
        (this.form.withholding_tax / 100) * this.higherValue +
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
}
</script>
