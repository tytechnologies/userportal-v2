<template>
  <div class="flex justify-center px-6 py-8 bg-card">
    <div class="tax-computation-form">
      <h1 class="mb-6 text-2xl font-bold text-center">
        INDIVIDUAL TAX COMPUTATION - Nett / ZV
      </h1>

      <h3 class="mb-4 text-lg font-bold">Unit ZV</h3>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Unit Size</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="Enter value"
            type="number"
            min="0"
            required
            v-model="form.size"
          />
        </div>

        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="unitSizeFormatted"
          />
        </div>
      </div>
      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Zonal Value</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="Enter value"
            type="number"
            min="0"
            required
            v-model="form.zonal"
          />
        </div>

        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="zonalAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Parking Size</label>
        </div>
        <div class="mb-2">
          <Input
            placeholder="Enter value"
            type="number"
            min="0"
            required
            v-model="form.parkingSize"
          />
        </div>

        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="parkingSizeFormatted"
          />
        </div>
      </div>
      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label>Parking Zonal Value</label>
        </div>
        <div class="mb-2">&nbsp;</div>

        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="parkingZonalAmountFormatted"
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
            placeholder="Enter value"
            type="number"
            min="0"
            required
            v-model="form.gross"
          />
        </div>

        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="grossAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label class="font-bold">Zonal Value</label>
        </div>
        <div class="mb-2">&nbsp;</div>

        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="zvAmountFormatted"
          />
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label class="font-bold">Nett to Owner</label>
        </div>
        <div class="mb-2">&nbsp;</div>

        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="nettAmountFormatted"
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
              <label>Capital Gains Tax</label>
            </div>
            <div class="mb-2">
              <div class="flex">
                <div class="w-64">
                  <Input
                    placeholder="Enter value"
                    type="number"
                    min="0"
                    v-model="form.capital_gain_tax"
                  />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder=""
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
                    placeholder="Enter value"
                    type="number"
                    min="0"
                    v-model="form.commission"
                  />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder=""
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
              <label class="font-bold"
                >Total Seller Gross with Commission</label
              >
            </div>
            <div class="hidden mb-2 sm:block md:block lg:block">&nbsp;</div>
            <div class="mb-2">
              <Input
                placeholder=""
                type="text"
                disabled
                :value="sellerAmountFormatted"
              />
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
                    placeholder="Enter value"
                    type="number"
                    min="0"
                    v-model="form.documentary_stamp_tax"
                  />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder=""
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
                    placeholder="Enter value"
                    type="number"
                    v-model="form.transfer_tax"
                  />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder=""
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
                    placeholder="Enter value"
                    type="number"
                    min="0"
                    v-model="form.registration_fee"
                  />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder=""
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
                    placeholder="Enter value"
                    type="number"
                    v-model="form.misc_fee"
                  />
                </div>
                <div class="percent-suffix">%</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder=""
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
              <div class="flex">
                <div class="w-64">
                  <Input
                    placeholder="Enter value"
                    type="number"
                    min="0"
                    v-model="form.processing_fee"
                  />
                </div>
                <div class="percent-suffix">&nbsp;</div>
              </div>
            </div>
            <div class="mb-2">
              <Input
                placeholder=""
                type="text"
                disabled
                :value="processingFeeAmountFormatted"
              />
            </div>
          </div>

          <div
            class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
          >
            <div class="mb-2">
              <label class="font-bold">Total Buyer</label>
            </div>
            <div class="w-64 mb-2"></div>
            <div class="mb-2">
              <Input
                placeholder=""
                type="text"
                disabled
                :value="buyerAmountFormatted"
              />
            </div>
          </div>
        </div>
      </div>

      <div
        class="w-full grid-rows-3 gap-4 mb-4 sm:grid md:grid lg:grid sm:grid-rows-3 md:grid-cols-3 lg:grid-cols-3 md:grid-rows-1 lg:grid-cols-1"
      >
        <div class="mb-2">
          <label class="text-xl font-bold">All In</label>
        </div>
        <div class="w-64 mb-2"></div>
        <div class="mb-2">
          <Input
            placeholder=""
            type="text"
            disabled
            :value="totalAmountFormatted"
          />
        </div>
      </div>

      <div class="w-full gap-4 mb-4">
        <div class="flex mt-auto">
          <button
            type="button"
            class="ml-auto rounded-lg btn-save-width h-9 bg-green"
            @click="generateUrl"
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

  props: {},

  data() {
    return {
      form: {
        size: null,
        parkingSize: null,
        zonal: null,
        gross: null,
        type: 'individualFinalNettZV',
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
      return this.zonalValueAmount * (this.form.capital_gain_tax / 100)
    },

    commissionAmount() {
      return this.zonalValueAmount * (this.form.commission / 100)
    },

    sellerAmount() {
      return (
        parseFloat(this.nettToOwnerAmount) +
        parseFloat(this.capitalGainTaxAmount) +
        parseFloat(this.commissionAmount)
      )
    },

    zonalValueAmount() {
      return (
        parseFloat(this.form.size) * parseFloat(this.form.zonal) +
        parseFloat(this.form.parkingSize) *
          parseFloat(this.parkingZonalValueAmount)
      )
    },

    parkingZonalValueAmount() {
      return this.form.parkingSize > 0 ? parseFloat(this.form.zonal) * 0.7 : 0.0
    },

    documentaryStampTaxAmount() {
      return this.zonalValueAmount * (this.form.documentary_stamp_tax / 100)
    },

    transferTaxAmount() {
      return this.zonalValueAmount * (this.form.transfer_tax / 100)
    },

    nettToOwnerAmount() {
      return this.form.gross !== null
        ? this.form.gross - this.capitalGainTaxAmount - this.commissionAmount
        : 0
    },

    registrationFeeAmount() {
      return this.nettToOwnerAmount * (this.form.registration_fee / 100)
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

    unitSizeFormatted() {
      return this.form.size !== null ? this.form.size + ' sqm' : ''
    },
    parkingSizeFormatted() {
      return this.form.parkingSize !== null
        ? this.form.parkingSize + ' sqm'
        : ''
    },
    zvAmountFormatted() {
      return this.zonalValueAmount !== null && this.zonalValueAmount > 0
        ? formatMoney(this.zonalValueAmount)
        : ''
    },
    parkingZonalAmountFormatted() {
      return this.parkingZonalValueAmount !== null &&
        this.parkingZonalValueAmount > 0
        ? formatMoney(this.parkingZonalValueAmount)
        : ''
    },
    zonalAmountFormatted() {
      return this.form.zonal !== null ? formatMoney(this.form.zonal) : ''
    },

    nettAmountFormatted() {
      return this.nettToOwnerAmount !== 0
        ? formatMoney(this.nettToOwnerAmount)
        : ''
    },
    grossAmountFormatted() {
      return this.form.gross !== null ? formatMoney(this.form.gross) : ''
    },

    capitalGainTaxAmountFormatted() {
      return formatMoney(this.capitalGainTaxAmount, true)
    },

    commissionAmountFormatted() {
      return formatMoney(
        this.zonalValueAmount * (this.form.commission / 100),
        true
      )
    },

    documentaryStampTaxAmountFormatted() {
      return formatMoney(this.documentaryStampTaxAmount, true)
    },

    transferTaxAmountFormatted() {
      return formatMoney(this.transferTaxAmount, true)
    },

    registrationFeeAmountFormatted() {
      return formatMoney(this.registrationFeeAmount, true)
    },

    miscFeeAmountFormatted() {
      return formatMoney(this.miscFeeAmount, true)
    },

    processingFeeAmountFormatted() {
      return formatMoney(this.form.processing_fee, true)
    },

    sellerAmountFormatted() {
      return formatMoney(this.sellerAmount, true)
    },

    buyerAmountFormatted() {
      return formatMoney(this.buyerAmount, true)
    },

    totalAmountFormatted() {
      return formatMoney(this.sellerAmount + this.buyerAmount, true)
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
          link.target = '_blank'
          //link.setAttribute('download', filename);
          document.body.appendChild(link)
          link.click()
          link.remove()
          dismissLoading()
          showToast({ title: 'Document downloaded!' })
        })
    },

    generateUrl() {
      const link = document.createElement('a')
      link.href = this.url()
      link.target = '_blank'
      link.click()
      link.remove()
    },

    url() {
      return (
        process.env.API_URL +
        '/' +
        apiRoutes['documents.tax-computation.generate'] +
        '?' +
        this.queryParams()
      )
    },

    queryParams() {
      return Object.keys(this.form)
        .map((key) => `${key}=${encodeURIComponent(this.form[key])}`)
        .join('&')
    },

    previewDocument() {
      this.$refs.taxComputationPreviewModal.toggleModal()
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
