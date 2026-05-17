<template>
  <div class="flex justify-center px-6 py-8 bg-card">
    <div class="tax-computation-form">
      <h1 class="mb-6 text-2xl font-bold text-center">
        CORPORATE TAX COMPUTATION
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
            class="w-64"
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

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label class="font-bold">Zonal Value</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="number"
            required
            v-model="form.zonal_value_amount"
            class="w-64"
          />
        </div>

        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="zonalValueAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label class="font-bold">Gross Price</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="number"
            required
            v-model="form.gross_amount"
            class="w-64"
          />
        </div>

        <div class="mb-2">
          <Input
            placeholder="0.00"
            type="text"
            disabled
            :value="grossAmountFormatted"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 class="mb-4 text-lg font-bold">Seller Side</h3>

          <div
            class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
          >
            <div class="mb-2">
              <label>EWT</label>
            </div>
            <div class="mb-2">
              <div class="flex">
                <div class="w-64">
                  <Input placeholder="0.0" type="number" v-model="form.ewt" />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder="0.00"
                type="text"
                disabled
                :value="ewtAmountFormatted"
              />
            </div>
          </div>

          <div
            class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
          >
            <div class="mb-2">
              <label>VAT</label>
            </div>
            <div class="mb-2">
              <div class="flex">
                <div class="w-64">
                  <Input placeholder="0.0" type="number" v-model="form.vat" />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder="0.00"
                type="text"
                disabled
                :value="vatAmountFormatted"
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
              <label class="font-bold">Total Seller</label>
            </div>
            <div class="mb-2"></div>
            <div class="mb-2">
              <div class="mb-2">
                <Input
                  placeholder="0.00"
                  type="text"
                  disabled
                  :value="sellerAmountFormatted"
                />
              </div>
            </div>
          </div>
        </div>

        <div>
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
                  <Input
                    placeholder="0.0"
                    type="number"
                    v-model="form.misc_fee"
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
              <label class="font-bold">Buyer's Account</label>
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
    /** Optional cross-entity links — caller can pre-link the saved record
     *  to a contact / listing so it surfaces on those entities'
     *  Documents panels. */
    contactId: { type: Number, default: null },
    listingId: { type: Number, default: null },
  },

  data() {
    return {
      isSaving: false,
      form: {
        type: 'corporate',
        nett: 0, //23454600.00,
        zonal_value_amount: 0, //15908000.00,
        gross_amount: 0, //25000000.00,
        ewt: 5.0,
        vat: 12.0,
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
    grossAmount() {
      return this.form.gross_amount
    },

    ewtAmount() {
      return this.form.zonal_value_amount * (this.form.ewt / 100)
    },

    vatAmount() {
      return this.form.zonal_value_amount * (this.form.vat / 100)
    },

    commissionAmount() {
      return this.grossAmount * (this.form.commission / 100)
    },

    sellerAmount() {
      return parseFloat(this.ewtAmount) + parseFloat(this.commissionAmount)
    },

    documentaryStampTaxAmount() {
      return (
        this.form.zonal_value_amount * (this.form.documentary_stamp_tax / 100)
      )
    },

    transferTaxAmount() {
      return this.form.zonal_value_amount * (this.form.transfer_tax / 100)
    },

    registrationFeeAmount() {
      return this.form.zonal_value_amount * (this.form.registration_fee / 100)
    },

    miscFeeAmount() {
      return this.form.gross_amount * (this.form.misc_fee / 100)
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

    zonalValueAmountFormatted() {
      return formatMoney(this.form.zonal_value_amount)
    },

    grossAmountFormatted() {
      return formatMoney(this.grossAmount)
    },

    nettAmountFormatted() {
      return formatMoney(this.form.nett)
    },

    ewtAmountFormatted() {
      return formatMoney(this.ewtAmount)
    },

    vatAmountFormatted() {
      return formatMoney(this.vatAmount)
    },

    commissionAmountFormatted() {
      return formatMoney(this.commissionAmount)
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
      return formatMoney(this.form.gross_amount + this.buyerAmount)
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
      const defaultTitle = `Corporate · ₱${Number(this.form.nett || 0).toLocaleString()}`
      const title = window.prompt('Title for this record (optional)', defaultTitle)
      if (title === null) return

      this.isSaving = true
      try {
        const { useTaxComputations } = await import('~/composables/useTaxComputations')
        const { createTaxComputation } = useTaxComputations()
        await createTaxComputation({
          taxpayer_type: 'corporate',
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
