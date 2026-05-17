<template>
  <div class="flex justify-center px-6 py-8 bg-card">
    <div class="tax-computation-form">
      <h1 class="mb-6 text-2xl font-bold text-center">
        INDIVIDUAL TAX COMPUTATION - Nett
      </h1>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label class="font-bold">NETT To Owner</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="number"
            required
            v-model="form.nett"
          />
        </div>

        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="nettAmountFormatted"
          />
        </div>
      </div>

      <h3 class="mb-4 text-lg font-bold">Seller Side</h3>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Capital Gain Tax</label>
        </div>
        <div class="mb-2">
          <div class="flex">
            <div class="w-64">
              <Input
                placeholder="0.0"
                type="number"
                v-model="form.capital_gain_tax"
              />
            </div>
            <div class="percent-suffix">%</div>
          </div>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="capitalGainTaxAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Commission</label>
        </div>
        <div class="mb-2">
          <div class="flex">
            <div class="w-64">
              <Input
                placeholder="0.0"
                type="number"
                v-model="form.commission"
              />
            </div>
            <div class="percent-suffix">%</div>
          </div>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="commissionAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label class="font-bold">Total Seller Gross</label>
        </div>
        <div class="hidden mb-2 sm:block md:block lg:block">&nbsp;</div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="sellerAmountFormatted"
          />
        </div>
      </div>

      <h3 class="mb-4 text-lg font-bold">Buyer Side</h3>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Documentary Stamp Tax</label>
        </div>
        <div class="mb-2">
          <div class="flex">
            <div class="w-64">
              <Input
                placeholder="0.0"
                type="number"
                v-model="form.documentary_stamp_tax"
              />
            </div>
            <div class="percent-suffix">%</div>
          </div>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="documentaryStampTaxAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Transfer Tax</label>
        </div>
        <div class="mb-2">
          <div class="flex">
            <div class="w-64">
              <Input
                placeholder="0.0"
                type="number"
                v-model="form.transfer_tax"
              />
            </div>
            <div class="percent-suffix">%</div>
          </div>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00..."
            type="text"
            disabled
            :value="transferTaxAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Registration Fee</label>
        </div>
        <div class="mb-2">
          <div class="flex">
            <div class="w-64">
              <Input
                placeholder="0.0..."
                type="number"
                v-model="form.registration_fee"
              />
            </div>
            <div class="percent-suffix">%</div>
          </div>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00..."
            type="text"
            disabled
            :value="registrationFeeAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Miscellaneous</label>
        </div>
        <div class="mb-2">
          <div class="flex">
            <div class="w-64">
              <Input placeholder="0.0" type="number" v-model="form.misc_fee" />
            </div>
            <div class="percent-suffix">%</div>
          </div>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00..."
            type="text"
            disabled
            :value="miscFeeAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Processing Fee</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="number"
            v-model="form.processing_fee"
            class="w-64"
          />
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="processingFeeAmountFormatted"
          />
        </div>
      </div>

      <div class="grid items-center w-full grid-cols-2 gap-4 mb-4">
        <div class="mb-2">
          <label class="font-bold">Total Buyer</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="buyerAmountFormatted"
          />
        </div>
      </div>

      <div class="grid items-center w-full grid-cols-2 gap-4 mb-4">
        <div class="mb-2">
          <label class="text-xl font-bold">All In</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="totalAmountFormatted"
          />
        </div>
      </div>

      <div class="w-full gap-4 mb-4">
        <div class="flex mt-auto gap-2">
          <button
            type="button"
            class="ml-auto rounded-lg btn-save-width h-9 border border-primary bg-card"
            :disabled="isSaving"
            @click="saveRecord"
          >
            <span class="inline-block text-primary font-bold mt-0.5">
              {{ isSaving ? 'Saving…' : 'Save record' }}
            </span>
          </button>
          <button
            type="button"
            class="rounded-lg btn-save-width h-9 bg-green"
            @click="previewDocument"
          >
            <span class="inline-block text-white font-bold mt-0.5"
              >Preview Document</span
            >
          </button>
        </div>
      </div>
    </div>

    <Modal :title="`Tax Computation Preview`" ref="taxComputationPreviewModal">
      <TaxComputationPreview :data="form" />
    </Modal>
  </div>
</template>

<script>
import { apiRoutes } from '~/contants'
import { formatMoney } from '~/helpers/formatMoney'
import { dismissLoading, showLoading, showToast } from '~/helpers/helpers'
import Input from '~/components/Input.vue'
import Modal from '@/components/Modal'
import TaxComputationPreview from '@/components/pages/documents/TaxComputationPreview.vue'

export default {
  components: {
    Input,
    Modal,
    TaxComputationPreview,
  },

  props: {
    /** Optional cross-entity links — caller can pre-link the record to a
     *  contact / listing so it surfaces on those entities' Documents
     *  panels. Both null when launched from /documents tabs without
     *  context. */
    contactId: { type: Number, default: null },
    listingId: { type: Number, default: null },
  },

  data() {
    return {
      isSaving: false,
      form: {
        type: 'generic',
        nett: 0.0,
        capital_gain_tax: 6.0,
        commission: 3.0,
        documentary_stamp_tax: 1.5,
        transfer_tax: 0.6,
        registration_fee: 0.5,
        misc_fee: 0.35,
        processing_fee: 45000,
      },
    }
  },

  computed: {
    capitalGainTaxAmount() {
      return this.form.nett * (this.form.capital_gain_tax / 100)
    },

    commissionAmount() {
      return this.form.nett * (this.form.commission / 100)
    },

    sellerAmount() {
      return (
        parseFloat(this.form.nett) +
        parseFloat(this.capitalGainTaxAmount) +
        parseFloat(this.commissionAmount)
      )
    },

    documentaryStampTaxAmount() {
      return this.sellerAmount * (this.form.documentary_stamp_tax / 100)
    },

    transferTaxAmount() {
      return this.sellerAmount * (this.form.transfer_tax / 100)
    },

    registrationFeeAmount() {
      return this.sellerAmount * (this.form.registration_fee / 100)
    },

    miscFeeAmount() {
      return this.sellerAmount * (this.form.misc_fee / 100)
    },

    buyerAmount() {
      return (
        parseFloat(this.documentaryStampTaxAmount) +
        parseFloat(this.transferTaxAmount) +
        parseFloat(this.registrationFeeAmount) +
        parseFloat(this.miscFeeAmount) +
        parseFloat(this.form.processing_fee)
      )
    },

    nettAmountFormatted() {
      return formatMoney(this.form.nett)
    },

    capitalGainTaxAmountFormatted() {
      return formatMoney(this.capitalGainTaxAmount)
    },

    commissionAmountFormatted() {
      return formatMoney(this.form.nett * (this.form.commission / 100))
    },

    documentaryStampTaxAmountFormatted() {
      return formatMoney(this.documentaryStampTaxAmount)
    },

    transferTaxAmountFormatted() {
      return formatMoney(this.transferTaxAmount)
    },

    registrationFeeAmountFormatted() {
      return formatMoney(this.registrationFeeAmount)
    },

    miscFeeAmountFormatted() {
      return formatMoney(this.miscFeeAmount)
    },

    processingFeeAmountFormatted() {
      return formatMoney(this.form.processing_fee)
    },

    sellerAmountFormatted() {
      return formatMoney(this.sellerAmount)
    },

    buyerAmountFormatted() {
      return formatMoney(this.buyerAmount)
    },

    totalAmountFormatted() {
      return formatMoney(this.sellerAmount + this.buyerAmount)
    },
  },

  methods: {
    /**
     * use this for direct download
     */
    generate() {
      showLoading()
      this.$axios
        .$post(apiRoutes['documents.tax-computation.generate'], this.form, {
          responseType: 'arraybuffer',
        })
        .then((res) => {
          const filename = 'hi-tax-computation.pdf'
          const downloadUrl = window.URL.createObjectURL(new Blob([res]))
          const link = document.createElement('a')
          link.href = downloadUrl
          link.setAttribute('download', filename)
          document.body.appendChild(link)
          link.click()
          link.remove()
          dismissLoading()
          showToast({ title: 'Document downloaded!' })
        })
    },

    previewDocument() {
      this.$refs.taxComputationPreviewModal.toggleModal()
    },

    async saveRecord() {
      if (this.isSaving) return
      // Single prompt for an optional title — keeps the legacy form's
      // imperative shape simple. A modal-based pre-link picker can be
      // added later when product asks for it.
      const defaultTitle = `Individual nett · ₱${Number(this.form.nett || 0).toLocaleString()}`
      const title = window.prompt('Title for this record (optional)', defaultTitle)
      if (title === null) return // user cancelled

      this.isSaving = true
      try {
        const { useTaxComputations } = await import('~/composables/useTaxComputations')
        const { createTaxComputation } = useTaxComputations()
        await createTaxComputation({
          taxpayer_type: 'individual',
          computation_kind: 'nett',
          inputs: { ...this.form },
          title: title.trim() || null,
          contact_id: this.contactId ?? null,
          listing_id: this.listingId ?? null,
        })
        showToast({ title: 'Tax computation saved.', icon: 'success' })
      } catch (err) {
        showToast({
          title: err?.statusMessage || err?.message || 'Failed to save record',
          icon: 'error',
        })
      } finally {
        this.isSaving = false
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
